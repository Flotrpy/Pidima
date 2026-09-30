import { ConnectorError } from "../errors";
import type { SafeFetch } from "../types";
import {
  GOOGLE_AUTH,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN,
  GOOGLE_TOKENINFO,
  GOOGLE_USERINFO,
  throwGoogle,
} from "./api";

export function buildAuthorizeUrl(i: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set("client_id", i.clientId);
  u.searchParams.set("redirect_uri", i.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  u.searchParams.set("state", i.state);
  u.searchParams.set("code_challenge", i.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  // Offline + consent so Google issues a refresh token; no incremental/extra scopes.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  return u.toString();
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope: string[];
};

async function tokenRequest(fetch: SafeFetch, body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "ai-action-inbox",
    },
    body: new URLSearchParams(body).toString(),
  });
  const j = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  } | null;
  if (!res.ok || !j?.access_token)
    throwGoogle(res.status === 400 && j?.error === "invalid_grant" ? 401 : res.status, j, false);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresIn: j.expires_in,
    scope: (j.scope ?? "").split(" ").filter(Boolean),
  };
}

export const exchangeCode = (
  fetch: SafeFetch,
  i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
) =>
  tokenRequest(fetch, {
    client_id: i.clientId,
    client_secret: i.clientSecret,
    code: i.code,
    redirect_uri: i.redirectUri,
    code_verifier: i.codeVerifier,
    grant_type: "authorization_code",
  });

export const refreshAccessToken = (
  fetch: SafeFetch,
  i: { clientId: string; clientSecret: string; refreshToken: string },
) =>
  tokenRequest(fetch, {
    client_id: i.clientId,
    client_secret: i.clientSecret,
    refresh_token: i.refreshToken,
    grant_type: "refresh_token",
  });

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export async function fetchIdentity(fetch: SafeFetch, token: string): Promise<GoogleIdentity> {
  const res = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "ai-action-inbox" },
  });
  const j = (await res.json().catch(() => null)) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  } | null;
  if (!res.ok) throwGoogle(res.status, j as never, false);
  if (!j?.sub || !j.email)
    throw new ConnectorError("provider_rejected", "Google did not identify the account");
  return {
    sub: j.sub,
    email: j.email.toLowerCase(),
    emailVerified: j.email_verified === true,
    name: j.name ?? null,
  };
}

/** Google's own statement of what this access token may do. */
export async function fetchGrantedScopes(fetch: SafeFetch, token: string): Promise<string[]> {
  const res = await fetch(`${GOOGLE_TOKENINFO}?${new URLSearchParams({ access_token: token })}`, {
    headers: { "user-agent": "ai-action-inbox" },
  });
  const j = (await res.json().catch(() => null)) as { scope?: string } | null;
  if (!res.ok) throwGoogle(res.status, j as never, false);
  return (j?.scope ?? "").split(" ").filter(Boolean);
}
