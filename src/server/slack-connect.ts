import "server-only";
import { ConnectorError } from "@/connectors/errors";
import { type SlackSenderMode } from "@/connectors/slack/api";
import { authTest, buildAuthorizeUrl, exchangeCode } from "@/connectors/slack/oauth";
import { safeFetchFor } from "@/connectors/transport";
import type { SafeFetch } from "@/connectors/types";
import { getEnv } from "@/lib/env";
import { connectAccount } from "./connectors";
import { OAuthTxError, beginOAuth, consumeOAuth } from "./oauth-tx";

export type SlackConnectFailure =
  "not_configured" | "denied" | "invalid" | "insufficient_scope" | "wrong_identity" | "failed";
export class SlackConnectError extends Error {
  constructor(public code: SlackConnectFailure) {
    super(code);
  }
}

const credentials = () => {
  const env = getEnv();
  if (!env.CONNECTOR_SLACK_CLIENT_ID || !env.CONNECTOR_SLACK_CLIENT_SECRET)
    throw new SlackConnectError("not_configured");
  return {
    clientId: env.CONNECTOR_SLACK_CLIENT_ID,
    clientSecret: env.CONNECTOR_SLACK_CLIENT_SECRET,
  };
};

export async function startSlackConnect(input: {
  userId: string;
  workspaceId: string;
  mode: SlackSenderMode;
}): Promise<string> {
  const { clientId } = credentials();
  // The sender mode is stored server-side with the transaction, so it cannot be changed in the browser.
  const tx = await beginOAuth({
    userId: input.userId,
    workspaceId: input.workspaceId,
    provider: "slack",
    returnTo: "/connections",
    context: { senderMode: input.mode },
  });
  return buildAuthorizeUrl({
    clientId,
    redirectUri: tx.redirectUri,
    state: tx.state,
    mode: input.mode,
  });
}

export async function completeSlackConnect(
  input: { userId: string; state: string | null; code: string | null; error: string | null },
  fetch: SafeFetch = safeFetchFor("slack"),
): Promise<{ returnTo: string; connectorAccountId: string }> {
  const { clientId, clientSecret } = credentials();
  let tx;
  try {
    tx = await consumeOAuth({ state: input.state ?? "", userId: input.userId, provider: "slack" });
  } catch (e) {
    if (e instanceof OAuthTxError) throw new SlackConnectError("invalid");
    throw e;
  }
  const mode: SlackSenderMode = tx.context.senderMode === "user" ? "user" : "bot";
  if (input.error)
    throw new SlackConnectError(input.error === "access_denied" ? "denied" : "failed");
  if (!input.code || input.code.length > 512) throw new SlackConnectError("invalid");

  try {
    const install = await exchangeCode(fetch, {
      clientId,
      clientSecret,
      code: input.code,
      redirectUri: tx.redirectUri,
    });
    const token = mode === "bot" ? install.botToken : install.userToken;
    if (!token) throw new SlackConnectError("failed");
    // Trust Slack's own account of who this token is, not the OAuth response alone.
    const who = await authTest(fetch, token);
    if (who.teamId !== install.teamId) throw new SlackConnectError("wrong_identity");
    if (mode === "bot" && !who.isBot) throw new SlackConnectError("wrong_identity");
    if (mode === "user" && who.isBot) throw new SlackConnectError("wrong_identity");

    const granted = who.scopes.length
      ? who.scopes
      : mode === "bot"
        ? install.scopes
        : install.userScopes;
    if (!granted.includes("chat:write")) throw new SlackConnectError("insufficient_scope");

    const label = mode === "bot" ? `${who.team} (app)` : `${who.team} (as ${who.user})`;
    const acct = await connectAccount({
      workspaceId: tx.workspaceId,
      actorId: input.userId,
      provider: "slack",
      // A bot and a person are different senders: separate connections per (team, sender).
      externalAccountId: mode === "bot" ? `${who.teamId}:bot` : `${who.teamId}:user:${who.userId}`,
      displayName: label,
      grantedScopes: granted,
      metadata: {
        senderMode: mode,
        teamId: who.teamId,
        teamName: who.team,
        userId: who.userId,
        userName: who.user,
        botId: who.botId,
        botUserId: install.botUserId ?? null,
        enterpriseInstall: install.enterpriseInstall,
      },
      credentials: {
        accessToken: token,
        refreshToken: install.refreshToken,
        tokenType: mode,
        scope: granted.join(","),
      },
      accessExpiresAt: install.expiresIn ? new Date(Date.now() + install.expiresIn * 1000) : null,
    });
    return { returnTo: tx.returnTo, connectorAccountId: acct.id };
  } catch (e) {
    if (e instanceof SlackConnectError) throw e;
    if (e instanceof ConnectorError)
      throw new SlackConnectError(e.category === "auth_expired" ? "failed" : "failed");
    throw e;
  }
}
