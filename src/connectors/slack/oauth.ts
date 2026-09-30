import { ConnectorError } from "../errors";
import { categorizeStatus } from "../transport";
import type { SafeFetch } from "../types";
import {
  SLACK_API,
  SLACK_SCOPES,
  SLACK_WEB,
  parseScopeHeader,
  slackHeaders,
  throwSlack,
  type SlackSenderMode,
} from "./api";

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  mode: SlackSenderMode;
}): string {
  const u = new URL(`${SLACK_WEB}/oauth/v2/authorize`);
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("state", input.state);
  // Bot mode installs the app with bot scopes; user mode requests only user scopes so no bot is installed.
  u.searchParams.set(input.mode === "bot" ? "scope" : "user_scope", SLACK_SCOPES.join(","));
  return u.toString();
}

export type SlackInstall = {
  teamId: string;
  teamName: string;
  botToken?: string;
  botUserId?: string;
  userToken?: string;
  userId?: string;
  scopes: string[];
  userScopes: string[];
  refreshToken?: string;
  expiresIn?: number;
  enterpriseInstall: boolean;
};

type RawAccess = {
  ok?: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  refresh_token?: string;
  expires_in?: number;
  team?: { id?: string; name?: string };
  authed_user?: {
    id?: string;
    access_token?: string;
    scope?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  is_enterprise_install?: boolean;
};

async function accessRequest(fetch: SafeFetch, body: Record<string, string>): Promise<RawAccess> {
  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "ai-action-inbox",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok)
    throw new ConnectorError(
      categorizeStatus(res.status, false).category,
      "Slack could not complete the authorization",
    );
  const json = (await res.json().catch(() => null)) as RawAccess | null;
  if (!json)
    throw new ConnectorError("provider_unavailable", "Slack returned an unreadable response");
  if (!json.ok) throwSlack(json.error);
  return json;
}

const split = (s?: string) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export async function exchangeCode(
  fetch: SafeFetch,
  i: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<SlackInstall> {
  const r = await accessRequest(fetch, {
    client_id: i.clientId,
    client_secret: i.clientSecret,
    code: i.code,
    redirect_uri: i.redirectUri,
  });
  if (!r.team?.id)
    throw new ConnectorError("provider_rejected", "Slack did not identify a workspace");
  return {
    teamId: r.team.id,
    teamName: r.team.name ?? r.team.id,
    botToken:
      r.token_type === "bot" || r.access_token?.startsWith("xoxb-") ? r.access_token : undefined,
    botUserId: r.bot_user_id,
    userToken: r.authed_user?.access_token,
    userId: r.authed_user?.id,
    scopes: split(r.scope),
    userScopes: split(r.authed_user?.scope),
    refreshToken: r.refresh_token ?? r.authed_user?.refresh_token,
    expiresIn: r.expires_in ?? r.authed_user?.expires_in,
    enterpriseInstall: !!r.is_enterprise_install,
  };
}

export async function refreshAccessToken(
  fetch: SafeFetch,
  i: { clientId: string; clientSecret: string; refreshToken: string },
) {
  const r = await accessRequest(fetch, {
    client_id: i.clientId,
    client_secret: i.clientSecret,
    grant_type: "refresh_token",
    refresh_token: i.refreshToken,
  });
  if (!r.access_token) throw new ConnectorError("auth_expired", "Slack did not issue a new token");
  return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresIn: r.expires_in };
}

export type SlackIdentity = {
  teamId: string;
  team: string;
  userId: string;
  user: string;
  botId: string | null;
  isBot: boolean;
  scopes: string[];
};

/** Who this token acts as, verified with Slack, plus Slack's statement of the token's scopes. */
export async function authTest(fetch: SafeFetch, token: string): Promise<SlackIdentity> {
  const res = await fetch(`${SLACK_API}/auth.test`, {
    method: "POST",
    headers: slackHeaders(token),
  });
  if (!res.ok)
    throw new ConnectorError(
      categorizeStatus(res.status, false).category,
      "Slack could not verify the connection",
    );
  const j = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    team_id?: string;
    team?: string;
    user_id?: string;
    user?: string;
    bot_id?: string;
  } | null;
  if (!j) throw new ConnectorError("provider_unavailable", "Slack returned an unreadable response");
  if (!j.ok) throwSlack(j.error);
  if (!j.team_id || !j.user_id)
    throw new ConnectorError("provider_rejected", "Unexpected response from Slack");
  return {
    teamId: j.team_id,
    team: j.team ?? j.team_id,
    userId: j.user_id,
    user: j.user ?? j.user_id,
    botId: j.bot_id ?? null,
    isBot: !!j.bot_id,
    scopes: parseScopeHeader(res.headers.get("x-oauth-scopes")),
  };
}
