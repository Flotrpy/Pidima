import { createSafeFetch } from "@/connectors/transport";
import type { SafeFetch } from "@/connectors/types";

export type FakeChannel = {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
};

export type FakeSlackOptions = {
  team?: { id: string; name: string };
  install?: "bot" | "user";
  botToken?: string;
  userToken?: string;
  scopes?: string;
  botUserId?: string;
  userId?: string;
  userName?: string;
  channels?: FakeChannel[];
  /** Force an ok:false error for a Slack method, e.g. { "chat.postMessage": "not_in_channel" }. */
  errors?: Record<string, string>;
  /** Force an HTTP status for a method. */
  statuses?: Record<string, number>;
  /** Slack posts the message but the response is lost. */
  dropPostResponse?: boolean;
  /** auth.test claims this token is/isn't a bot regardless of what it is. */
  authTestOverride?: Partial<{ team_id: string; bot_id: string | undefined; user_id: string }>;
  refreshable?: boolean;
};

/** Stateful Slack stand-in: enforces auth, records every call and every posted message. Fixture only. */
export function fakeSlack(opts: FakeSlackOptions = {}) {
  const team = opts.team ?? { id: "T0123ABCDE", name: "Acme" };
  const botToken = opts.botToken ?? "xoxb-test-bot-token";
  const userToken = opts.userToken ?? "xoxp-test-user-token";
  const scopes = opts.scopes ?? "chat:write,channels:read,groups:read";
  const channels = opts.channels ?? [{ id: "C0123456789", name: "ops", is_member: true }];
  const calls: { method: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const messages: {
    channel: string;
    text: string;
    thread_ts?: string;
    ts: string;
    as: "bot" | "user";
    client_msg_id?: string;
  }[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = url.pathname.replace("/api/", "");
    const headers = new Headers(init?.headers);
    const raw = String(init?.body ?? "");
    let body: Record<string, unknown> = {};
    if (raw) {
      const type = headers.get("content-type") ?? "";
      if (type.includes("json")) body = JSON.parse(raw);
      else body = Object.fromEntries(new URLSearchParams(raw));
    }
    for (const [k, v] of url.searchParams) body[k] = v;
    const auth = headers.get("authorization");
    calls.push({ method, auth, body });

    const ok = (o: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify({ ok: true, ...o }), {
        headers: { "content-type": "application/json", "x-oauth-scopes": scopes, ...extra },
      });
    const err = (e: string) =>
      new Response(JSON.stringify({ ok: false, error: e }), {
        headers: { "content-type": "application/json" },
      });
    if (opts.statuses?.[method])
      return new Response("{}", {
        status: opts.statuses[method],
        headers: { "retry-after": "30" },
      });
    if (opts.errors?.[method]) return err(opts.errors[method]!);

    if (method === "oauth.v2.access") {
      if (body.client_id !== "slack-client-id" || body.client_secret !== "slack-client-secret")
        return err("bad_client_secret");
      if (body.grant_type === "refresh_token")
        return body.refresh_token === "refresh-1"
          ? ok({
              access_token: "xoxb-refreshed",
              refresh_token: "refresh-2",
              expires_in: 43200,
              token_type: "bot",
            })
          : err("invalid_refresh_token");
      if (body.code !== "good-code") return err("invalid_code");
      const install = opts.install ?? "bot";
      return ok({
        team: { id: team.id, name: team.name },
        ...(install === "bot"
          ? {
              access_token: botToken,
              token_type: "bot",
              scope: scopes,
              bot_user_id: opts.botUserId ?? "UBOT12345",
              ...(opts.refreshable ? { refresh_token: "refresh-1", expires_in: 43200 } : {}),
            }
          : {}),
        ...(install === "user"
          ? {
              authed_user: {
                id: opts.userId ?? "U0MAYA123",
                access_token: userToken,
                scope: scopes,
              },
            }
          : { authed_user: { id: opts.userId ?? "U0MAYA123" } }),
      });
    }

    const isBot = auth === `Bearer ${botToken}`;
    const isUser = auth === `Bearer ${userToken}`;
    if (!isBot && !isUser) return err("invalid_auth");

    if (method === "auth.test") {
      const o = opts.authTestOverride ?? {};
      return ok({
        url: `https://${team.name.toLowerCase()}.slack.com/`,
        team: team.name,
        team_id: o.team_id ?? team.id,
        user: isBot ? "acme_app" : (opts.userName ?? "maya"),
        user_id:
          o.user_id ?? (isBot ? (opts.botUserId ?? "UBOT12345") : (opts.userId ?? "U0MAYA123")),
        ...(isBot ? { bot_id: "bot_id" in o ? o.bot_id : "B0BOT12345" } : {}),
      });
    }

    if (method === "conversations.list") {
      const types = String(body.types ?? "public_channel").split(",");
      const list = channels.filter((c) =>
        c.is_private ? types.includes("private_channel") : types.includes("public_channel"),
      );
      const excludeArchived = body.exclude_archived === "true" || body.exclude_archived === true;
      return ok({
        channels: list
          .filter((c) => !(excludeArchived && c.is_archived))
          .map((c) => ({
            id: c.id,
            name: c.name,
            is_private: !!c.is_private,
            is_member: c.is_member ?? true,
            is_archived: !!c.is_archived,
          })),
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.info") {
      const c = channels.find((x) => x.id === body.channel);
      return c
        ? ok({
            channel: {
              id: c.id,
              name: c.name,
              is_private: !!c.is_private,
              is_member: c.is_member ?? true,
              is_archived: !!c.is_archived,
            },
          })
        : err("channel_not_found");
    }
    if (method === "chat.postMessage") {
      const c = channels.find((x) => x.id === body.channel);
      if (!c) return err("channel_not_found");
      if (c.is_archived) return err("is_archived");
      if (!(c.is_member ?? true)) return err("not_in_channel");
      if (!body.text) return err("no_text");
      const ts = `${1_700_000_000 + messages.length}.000100`;
      messages.push({
        channel: c.id,
        text: String(body.text),
        thread_ts: body.thread_ts as string | undefined,
        ts,
        as: isBot ? "bot" : "user",
      });
      if (opts.dropPostResponse)
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return ok({ channel: c.id, ts, message: { text: body.text } });
    }
    if (method === "chat.getPermalink")
      return ok({
        permalink: `https://${team.name.toLowerCase()}.slack.com/archives/${body.channel}/p${String(body.message_ts).replace(".", "")}`,
      });
    return err("unknown_method");
  };

  const sf: SafeFetch = createSafeFetch({
    allowedOrigins: ["https://slack.com"],
    fetchImpl,
    sleep: async () => {},
  });
  return { sf, fetchImpl, calls, messages, botToken, userToken, team, channels };
}
