import "server-only";
import { createHash, createHmac } from "node:crypto";
import { and, eq, isNull, lt, gt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { oauthTransactions } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { safeReturnTo } from "@/lib/redirect";
import { requirePermission } from "./authz";
import { randomToken, sha256 } from "./tokens";

export type OAuthProvider = "github" | "slack" | "gmail";
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

export class OAuthTxError extends Error {
  constructor() {
    // One generic message: callers must not learn which check failed.
    super("This connection attempt is invalid or has expired. Start again from Connections.");
  }
}

export function callbackUrl(provider: OAuthProvider): string {
  return `${getEnv().APP_URL}/api/connectors/${provider}/callback`;
}

/**
 * PKCE verifier derived from the state with a server-only key. Nothing sensitive is stored, and
 * an observer who sees the state (it travels through the browser) cannot compute the verifier.
 */
export function codeVerifierFor(state: string): string {
  const key = createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update("oauth-pkce-v1").digest();
  return createHmac("sha256", key).update(state).digest("base64url");
}

export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function beginOAuth(input: {
  userId: string;
  workspaceId: string;
  provider: OAuthProvider;
  returnTo?: string | null;
  context?: Record<string, string>;
}) {
  await requirePermission(input.userId, input.workspaceId, "connectors.manage");
  const state = randomToken(32);
  const redirectUri = callbackUrl(input.provider);
  await getDb()
    .insert(oauthTransactions)
    .values({
      stateHash: sha256(state),
      provider: input.provider,
      userId: input.userId,
      workspaceId: input.workspaceId,
      redirectUri,
      returnTo: safeReturnTo(input.returnTo, "/connections"),
      context: input.context ?? {},
      expiresAt: new Date(Date.now() + OAUTH_TX_TTL_MS),
    });
  return {
    state,
    redirectUri,
    codeChallenge: codeChallengeFor(codeVerifierFor(state)),
    codeChallengeMethod: "S256" as const,
  };
}

/**
 * Atomically consumes a transaction. The single conditional UPDATE guarantees single use even
 * under concurrent callbacks, and binds the callback to the initiating user and provider.
 */
export async function consumeOAuth(input: {
  state: string;
  userId: string;
  provider: OAuthProvider;
}) {
  if (!input.state || input.state.length > 200) throw new OAuthTxError();
  const [tx] = await getDb()
    .update(oauthTransactions)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthTransactions.stateHash, sha256(input.state)),
        eq(oauthTransactions.userId, input.userId),
        eq(oauthTransactions.provider, input.provider),
        isNull(oauthTransactions.consumedAt),
        gt(oauthTransactions.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!tx) throw new OAuthTxError();
  // Re-check on the way out in case the user lost permission mid-flow.
  await requirePermission(tx.userId, tx.workspaceId, "connectors.manage");
  return {
    workspaceId: tx.workspaceId,
    redirectUri: tx.redirectUri,
    returnTo: safeReturnTo(tx.returnTo, "/connections"),
    context: tx.context,
    codeVerifier: codeVerifierFor(input.state),
  };
}

export async function purgeExpiredOAuthTransactions(now = new Date()): Promise<number> {
  const rows = await getDb()
    .delete(oauthTransactions)
    .where(lt(oauthTransactions.expiresAt, new Date(now.getTime() - 60 * 60 * 1000)))
    .returning({ id: oauthTransactions.id });
  return rows.length;
}
