import "server-only";
import { type GithubScopeLevel } from "@/connectors/github/api";
import { buildAuthorizeUrl, exchangeCode, fetchIdentity } from "@/connectors/github/oauth";
import { ConnectorError } from "@/connectors/errors";
import { safeFetchFor } from "@/connectors/transport";
import type { SafeFetch } from "@/connectors/types";
import { getEnv } from "@/lib/env";
import { connectAccount } from "./connectors";
import { OAuthTxError, beginOAuth, consumeOAuth } from "./oauth-tx";

export type ConnectFailure =
  "not_configured" | "denied" | "invalid" | "insufficient_scope" | "failed";
export class GithubConnectError extends Error {
  constructor(public code: ConnectFailure) {
    super(code);
  }
}

const credentials = () => {
  const env = getEnv();
  if (!env.CONNECTOR_GITHUB_CLIENT_ID || !env.CONNECTOR_GITHUB_CLIENT_SECRET)
    throw new GithubConnectError("not_configured");
  return {
    clientId: env.CONNECTOR_GITHUB_CLIENT_ID,
    clientSecret: env.CONNECTOR_GITHUB_CLIENT_SECRET,
  };
};

export async function startGithubConnect(input: {
  userId: string;
  workspaceId: string;
  level: GithubScopeLevel;
  returnTo?: string | null;
}): Promise<string> {
  const { clientId } = credentials();
  const tx = await beginOAuth({
    userId: input.userId,
    workspaceId: input.workspaceId,
    provider: "github",
    returnTo: input.returnTo,
  });
  return buildAuthorizeUrl({
    clientId,
    redirectUri: tx.redirectUri,
    state: tx.state,
    codeChallenge: tx.codeChallenge,
    level: input.level,
  });
}

/**
 * Finishes the flow. The state is consumed first and only for the initiating user, so a replayed,
 * forged or cross-user callback stops here before any code is exchanged.
 */
export async function completeGithubConnect(
  input: { userId: string; state: string | null; code: string | null; error: string | null },
  fetch: SafeFetch = safeFetchFor("github"),
): Promise<{ returnTo: string; connectorAccountId: string }> {
  const { clientId, clientSecret } = credentials();
  let tx;
  try {
    tx = await consumeOAuth({ state: input.state ?? "", userId: input.userId, provider: "github" });
  } catch (e) {
    if (e instanceof OAuthTxError) throw new GithubConnectError("invalid");
    throw e;
  }
  if (input.error)
    throw new GithubConnectError(input.error === "access_denied" ? "denied" : "failed");
  if (!input.code || input.code.length > 512) throw new GithubConnectError("invalid");

  try {
    const tokens = await exchangeCode(fetch, {
      clientId,
      clientSecret,
      code: input.code,
      redirectUri: tx.redirectUri,
      codeVerifier: tx.codeVerifier,
    });
    const identity = await fetchIdentity(fetch, tokens.accessToken);
    // Trust GitHub's statement of granted scopes, not what we asked for.
    const granted = identity.scopes.length ? identity.scopes : tokens.scope;
    const usable = granted.includes("repo") || granted.includes("public_repo");
    if (!usable) throw new GithubConnectError("insufficient_scope");

    const acct = await connectAccount({
      workspaceId: tx.workspaceId,
      actorId: input.userId,
      provider: "github",
      externalAccountId: identity.id,
      displayName: identity.login,
      grantedScopes: granted,
      metadata: {
        login: identity.login,
        name: identity.name,
        accessLevel: granted.includes("repo") ? "public_and_private" : "public_only",
      },
      credentials: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: "bearer",
        scope: granted.join(","),
      },
      accessExpiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
    });
    return { returnTo: tx.returnTo, connectorAccountId: acct.id };
  } catch (e) {
    if (e instanceof GithubConnectError) throw e;
    if (e instanceof ConnectorError) throw new GithubConnectError("failed");
    throw e;
  }
}
