import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts } from "@/db/schema";
import { ConnectorError } from "@/connectors/errors";
import { recordAudit } from "./audit";
import { notifyConnectorUnhealthy } from "./notifications";
import {
  deleteCredentials,
  loadCredentials,
  storeCredentials,
  type StoredCredentials,
} from "./vault";

/** Refresh slightly before expiry so a token never dies mid-request. */
export const REFRESH_SKEW_MS = 60_000;

export type Refresher = (
  current: StoredCredentials,
) => Promise<{ credentials: StoredCredentials; expiresAt: Date | null }>;

type Status = "active" | "needs_reauth" | "revoked" | "disconnected";

async function accountStatus(id: string): Promise<{ status: Status; workspaceId: string } | null> {
  const [row] = await getDb()
    .select({ status: connectorAccounts.status, workspaceId: connectorAccounts.workspaceId })
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, id));
  return row ?? null;
}

async function setStatus(id: string, status: Status, action: string, workspaceId: string) {
  await getDb()
    .update(connectorAccounts)
    .set({ status, updatedAt: new Date() })
    .where(eq(connectorAccounts.id, id));
  await recordAudit({
    workspaceId,
    actorType: "system",
    action,
    subjectType: "connector_account",
    subjectId: id,
  });
}

/** Provider said the token is no longer valid (401 / invalid_grant / token_revoked). */
export async function reportAuthFailure(connectorAccountId: string) {
  const acct = await accountStatus(connectorAccountId);
  if (acct && acct.status === "active") {
    await setStatus(connectorAccountId, "needs_reauth", "connector.needs_reauth", acct.workspaceId);
    await notifyConnectorUnhealthy(acct.workspaceId, connectorAccountId).catch(() => undefined);
  }
}

/** Owner revoked or disconnected the connector: unexecuted proposals must not proceed. */
export async function revokeConnector(
  connectorAccountId: string,
  kind: "revoked" | "disconnected" = "revoked",
) {
  const acct = await accountStatus(connectorAccountId);
  if (!acct) return;
  await getDb().transaction(async (tx) => {
    await deleteCredentials(connectorAccountId, tx);
    await tx
      .update(connectorAccounts)
      .set({ status: kind, updatedAt: new Date() })
      .where(eq(connectorAccounts.id, connectorAccountId));
    await recordAudit(
      {
        workspaceId: acct.workspaceId,
        actorType: "system",
        action: `connector.${kind}`,
        subjectType: "connector_account",
        subjectId: connectorAccountId,
      },
      tx,
    );
  });
}

/**
 * Returns a usable access token, refreshing at most once across all callers and instances.
 * A transaction-scoped Postgres advisory lock serialises refreshes per connector; after taking
 * it we re-read the row, because another caller may already have refreshed.
 */
export async function getAccessToken(
  connectorAccountId: string,
  refresher?: Refresher,
): Promise<string> {
  const acct = await accountStatus(connectorAccountId);
  if (!acct || acct.status !== "active")
    throw new ConnectorError("auth_expired", "Connector is not active");

  const first = await loadCredentials(connectorAccountId);
  if (!first) throw new ConnectorError("auth_expired", "No credentials stored");
  if (isFresh(first.accessExpiresAt)) return first.credentials.accessToken;
  if (!refresher || !first.credentials.refreshToken) {
    // Expired and cannot be renewed automatically.
    await reportAuthFailure(connectorAccountId);
    throw new ConnectorError("auth_expired", "Access token expired and cannot be refreshed");
  }

  let failure: ConnectorError | null = null;
  const token = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"cred-refresh:" + connectorAccountId}))`,
    );
    const current = await loadCredentials(connectorAccountId, tx);
    if (!current) throw new ConnectorError("auth_expired", "No credentials stored");
    if (isFresh(current.accessExpiresAt)) return current.credentials.accessToken;
    try {
      const next = await refresher(current.credentials);
      // Providers may rotate the refresh token; never lose the newest one.
      const merged: StoredCredentials = {
        ...next.credentials,
        refreshToken: next.credentials.refreshToken ?? current.credentials.refreshToken,
      };
      await storeCredentials(connectorAccountId, merged, next.expiresAt, tx);
      return merged.accessToken;
    } catch (e) {
      failure =
        e instanceof ConnectorError
          ? e
          : new ConnectorError("provider_unavailable", "Token refresh failed");
      return null;
    }
  });

  if (token) return token;
  // Only a definitive rejection changes connector state; transient failures leave it active.
  if (failure!.category === "auth_expired") await reportAuthFailure(connectorAccountId);
  throw failure!;
}

const isFresh = (expiresAt: Date | null) =>
  expiresAt === null || expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS;
