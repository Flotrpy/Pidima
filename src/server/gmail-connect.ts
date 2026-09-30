import "server-only";
import { ConnectorError } from "@/connectors/errors";
import { SEND_SCOPE } from "@/connectors/gmail/api";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchGrantedScopes,
  fetchIdentity,
} from "@/connectors/gmail/oauth";
import { safeFetchFor } from "@/connectors/transport";
import type { SafeFetch } from "@/connectors/types";
import { getEnv } from "@/lib/env";
import { connectAccount } from "./connectors";
import { OAuthTxError, beginOAuth, consumeOAuth } from "./oauth-tx";

export type GmailConnectFailure =
  | "not_configured"
  | "denied"
  | "invalid"
  | "insufficient_scope"
  | "unverified_email"
  | "no_refresh"
  | "failed";
export class GmailConnectError extends Error {
  constructor(public code: GmailConnectFailure) {
    super(code);
  }
}

const creds = () => {
  const e = getEnv();
  if (!e.CONNECTOR_GOOGLE_CLIENT_ID || !e.CONNECTOR_GOOGLE_CLIENT_SECRET)
    throw new GmailConnectError("not_configured");
  return { clientId: e.CONNECTOR_GOOGLE_CLIENT_ID, clientSecret: e.CONNECTOR_GOOGLE_CLIENT_SECRET };
};

export async function startGmailConnect(input: {
  userId: string;
  workspaceId: string;
}): Promise<string> {
  const { clientId } = creds();
  const tx = await beginOAuth({
    userId: input.userId,
    workspaceId: input.workspaceId,
    provider: "gmail",
    returnTo: "/connections",
  });
  return buildAuthorizeUrl({
    clientId,
    redirectUri: tx.redirectUri,
    state: tx.state,
    codeChallenge: tx.codeChallenge,
  });
}

export async function completeGmailConnect(
  input: { userId: string; state: string | null; code: string | null; error: string | null },
  fetch: SafeFetch = safeFetchFor("gmail"),
) {
  const { clientId, clientSecret } = creds();
  let tx;
  try {
    tx = await consumeOAuth({ state: input.state ?? "", userId: input.userId, provider: "gmail" });
  } catch (e) {
    if (e instanceof OAuthTxError) throw new GmailConnectError("invalid");
    throw e;
  }
  if (input.error)
    throw new GmailConnectError(input.error === "access_denied" ? "denied" : "failed");
  if (!input.code || input.code.length > 1024) throw new GmailConnectError("invalid");
  try {
    const t = await exchangeCode(fetch, {
      clientId,
      clientSecret,
      code: input.code,
      redirectUri: tx.redirectUri,
      codeVerifier: tx.codeVerifier,
    });
    // Without a refresh token the connection would silently die in an hour.
    if (!t.refreshToken) throw new GmailConnectError("no_refresh");
    const [who, scopes] = await Promise.all([
      fetchIdentity(fetch, t.accessToken),
      fetchGrantedScopes(fetch, t.accessToken),
    ]);
    if (!scopes.includes(SEND_SCOPE)) throw new GmailConnectError("insufficient_scope");
    if (!who.emailVerified) throw new GmailConnectError("unverified_email");
    const acct = await connectAccount({
      workspaceId: tx.workspaceId,
      actorId: input.userId,
      provider: "gmail",
      externalAccountId: who.sub,
      displayName: who.email,
      grantedScopes: scopes,
      metadata: { email: who.email, name: who.name, senderAddresses: [who.email] },
      credentials: {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        tokenType: "bearer",
        scope: scopes.join(" "),
      },
      accessExpiresAt: t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000) : null,
    });
    return { returnTo: tx.returnTo, connectorAccountId: acct.id };
  } catch (e) {
    if (e instanceof GmailConnectError) throw e;
    if (e instanceof ConnectorError) throw new GmailConnectError("failed");
    throw e;
  }
}
