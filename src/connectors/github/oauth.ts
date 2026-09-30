import { ConnectorError } from "../errors";
import { categorizeStatus } from "../transport";
import type { SafeFetch } from "../types";
import {
  GITHUB_API,
  GITHUB_SCOPE_LEVELS,
  GITHUB_WEB,
  githubHeaders,
  parseScopeHeader,
  type GithubScopeLevel,
} from "./api";

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  level: GithubScopeLevel;
}): string {
  const u = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("scope", GITHUB_SCOPE_LEVELS[input.level].scope);
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

export type GithubTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope: string[];
};

async function tokenRequest(fetch: SafeFetch, body: Record<string, string>): Promise<GithubTokens> {
  const res = await fetch(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "ai-action-inbox",
    },
    body: new URLSearchParams(body).toString(),
  });
  // GitHub answers 200 with an `error` field for most OAuth failures.
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  } | null;
  if (!res.ok || !json)
    throw new ConnectorError("provider_unavailable", "GitHub could not complete the authorization");
  if (
    json.error === "bad_verification_code" ||
    json.error === "incorrect_client_credentials" ||
    json.error === "bad_refresh_token"
  )
    throw new ConnectorError("auth_expired", "GitHub rejected the authorization");
  if (json.error || !json.access_token)
    throw new ConnectorError("provider_rejected", "GitHub did not issue an access token");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    scope: (json.scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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
  });

export const refreshAccessToken = (
  fetch: SafeFetch,
  i: { clientId: string; clientSecret: string; refreshToken: string },
) =>
  tokenRequest(fetch, {
    client_id: i.clientId,
    client_secret: i.clientSecret,
    grant_type: "refresh_token",
    refresh_token: i.refreshToken,
  });

export type GithubIdentity = { id: string; login: string; name: string | null; scopes: string[] };

/** Who the token belongs to, and the scopes GitHub says it carries. Read-only. */
export async function fetchIdentity(fetch: SafeFetch, token: string): Promise<GithubIdentity> {
  const res = await fetch(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
  if (!res.ok) {
    const c = categorizeStatus(res.status, false);
    throw new ConnectorError(c.category, "Could not read the GitHub account");
  }
  const u = (await res.json()) as { id?: number; login?: string; name?: string | null };
  if (typeof u.id !== "number" || typeof u.login !== "string")
    throw new ConnectorError("provider_rejected", "Unexpected response from GitHub");
  return {
    id: String(u.id),
    login: u.login,
    name: u.name ?? null,
    scopes: parseScopeHeader(res.headers.get("x-oauth-scopes")),
  };
}
