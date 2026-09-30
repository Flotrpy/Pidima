import { createSafeFetch } from "@/connectors/transport";
import type { SafeFetch } from "@/connectors/types";

export type FakeGmailOptions = {
  email?: string;
  sub?: string;
  emailVerified?: boolean;
  scope?: string;
  accessToken?: string;
  refreshToken?: string | null;
  /** Status to force for a path suffix, e.g. { "/messages/send": 503 }. */
  statuses?: Record<string, number>;
  /** Google error body to return for a path suffix with status 4xx. */
  dropSendResponse?: boolean;
  revokedRefresh?: boolean;
};

/** Stateful Google/Gmail stand-in. Records every request and every accepted message. Fixture only. */
export function fakeGmail(opts: FakeGmailOptions = {}) {
  const email = opts.email ?? "maya@acme.com";
  const access = opts.accessToken ?? "ya29.test-access";
  const scope =
    opts.scope ??
    "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send";
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const sent: { id: string; raw: string; mime: string; threadId: string }[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const h = new Headers(init?.headers);
    let body: unknown = init?.body ? String(init.body) : undefined;
    try {
      body = JSON.parse(String(body));
    } catch {
      /* form body */
    }
    calls.push({ method, path: url.pathname, auth: h.get("authorization"), body });
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    for (const [suffix, st] of Object.entries(opts.statuses ?? {}))
      if (url.pathname.endsWith(suffix))
        return json(
          { error: { code: st, status: st === 401 ? "UNAUTHENTICATED" : "UNAVAILABLE" } },
          st,
        );

    if (url.pathname === "/oauth2/v3/certs") return json({ keys: [] });
    if (url.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
      if (
        form.get("client_id") !== "g-client-id" ||
        form.get("client_secret") !== "g-client-secret"
      )
        return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "refresh_token")
        return form.get("refresh_token") === (opts.refreshToken ?? "r-1") && !opts.revokedRefresh
          ? json({ access_token: "ya29.refreshed", expires_in: 3599, scope })
          : json({ error: "invalid_grant" }, 400);
      if (form.get("code") !== "good-code" || !form.get("code_verifier"))
        return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: access,
        expires_in: 3599,
        scope,
        ...(opts.refreshToken === null ? {} : { refresh_token: opts.refreshToken ?? "r-1" }),
      });
    }
    const bearer = h.get("authorization");
    if (url.pathname === "/tokeninfo")
      return url.searchParams.get("access_token") === access ||
        url.searchParams.get("access_token") === "ya29.refreshed"
        ? json({ scope, email })
        : json({ error: "invalid_token" }, 400);
    if (bearer !== `Bearer ${access}` && bearer !== "Bearer ya29.refreshed")
      return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
    if (url.pathname === "/oauth2/v3/userinfo")
      return json({
        sub: opts.sub ?? "1234567890",
        email,
        email_verified: opts.emailVerified ?? true,
        name: "Maya Chen",
      });
    if (url.pathname === "/gmail/v1/users/me/messages/send" && method === "POST") {
      const raw = (body as { raw?: string }).raw ?? "";
      const id = `18c${sent.length.toString(16).padStart(4, "0")}`;
      sent.push({ id, raw, mime: Buffer.from(raw, "base64url").toString("utf8"), threadId: id });
      if (opts.dropSendResponse)
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return json({ id, threadId: id, labelIds: ["SENT"] });
    }
    return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
  };
  const sf: SafeFetch = createSafeFetch({
    allowedOrigins: [
      "https://gmail.googleapis.com",
      "https://oauth2.googleapis.com",
      "https://www.googleapis.com",
      "https://accounts.google.com",
    ],
    fetchImpl,
    sleep: async () => {},
  });
  return { sf, fetchImpl, calls, sent, email, access };
}
