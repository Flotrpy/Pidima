import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, connectorTests } from "@/db/schema";
import { ConnectorError } from "@/connectors/errors";
import { getRuntime } from "@/connectors/registry";
import { safeFetchFor } from "@/connectors/transport";
import type { HealthTestResult, Provider, RuntimeContext } from "@/connectors/types";
import { recordAudit } from "./audit";
import { requirePermission } from "./authz";
import { getAccessToken, reportAuthFailure, revokeConnector } from "./credentials";
import { storeCredentials, type StoredCredentials } from "./vault";
import { WorkspaceError } from "./workspaces";

type Listener = (event: {
  workspaceId: string;
  connectorAccountId: string;
  change: string;
}) => void;
const listeners = new Set<Listener>();

/** Lets caches (e.g. MCP tool discovery) drop stale entries whenever connector state changes. */
export function onConnectorChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(workspaceId: string, connectorAccountId: string, change: string) {
  for (const l of listeners) l({ workspaceId, connectorAccountId, change });
}

export type ConnectInput = {
  workspaceId: string;
  actorId: string;
  provider: Provider;
  externalAccountId: string;
  displayName: string;
  grantedScopes: string[];
  metadata?: Record<string, unknown>;
  credentials: StoredCredentials;
  accessExpiresAt?: Date | null;
};

/** Creates or reconnects a connector account, replacing its credentials atomically. */
export async function connectAccount(input: ConnectInput) {
  await requirePermission(input.actorId, input.workspaceId, "connectors.manage");
  const result = await getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(connectorAccounts)
      .where(
        and(
          eq(connectorAccounts.workspaceId, input.workspaceId),
          eq(connectorAccounts.provider, input.provider),
          eq(connectorAccounts.externalAccountId, input.externalAccountId),
        ),
      );
    const values = {
      displayName: input.displayName,
      grantedScopes: input.grantedScopes,
      metadata: input.metadata ?? {},
      status: "active" as const,
      connectedByUserId: input.actorId,
      updatedAt: new Date(),
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await tx.update(connectorAccounts).set(values).where(eq(connectorAccounts.id, id));
    } else {
      const [row] = await tx
        .insert(connectorAccounts)
        .values({
          workspaceId: input.workspaceId,
          provider: input.provider,
          externalAccountId: input.externalAccountId,
          ...values,
        })
        .returning({ id: connectorAccounts.id });
      id = row!.id;
    }
    await storeCredentials(id, input.credentials, input.accessExpiresAt ?? null, tx);
    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: "user",
        actorId: input.actorId,
        action: existing ? "connector.reconnected" : "connector.connected",
        subjectType: "connector_account",
        subjectId: id,
        detail: { provider: input.provider, scopes: input.grantedScopes },
      },
      tx,
    );
    return { id, reconnected: !!existing };
  });
  emit(input.workspaceId, result.id, result.reconnected ? "reconnected" : "connected");
  return result;
}

async function loadOwned(
  actorId: string,
  accountId: string,
  permission: "connectors.manage" | "proposals.view",
) {
  const [acct] = await getDb()
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, accountId));
  // Same answer for "missing" and "someone else's": no cross-workspace probing.
  if (!acct) throw new WorkspaceError("not_found", "Connection not found");
  await requirePermission(actorId, acct.workspaceId, permission).catch((e) => {
    throw e instanceof WorkspaceError && e.code === "not_found"
      ? new WorkspaceError("not_found", "Connection not found")
      : e;
  });
  return acct;
}

export function runtimeContextFor(acct: typeof connectorAccounts.$inferSelect): RuntimeContext {
  const runtime = getRuntime(acct.provider);
  return {
    account: {
      id: acct.id,
      workspaceId: acct.workspaceId,
      externalAccountId: acct.externalAccountId,
      displayName: acct.displayName,
      grantedScopes: acct.grantedScopes,
      metadata: acct.metadata,
    },
    getAccessToken: () =>
      getAccessToken(acct.id, runtime.refresh ? (cur) => runtime.refresh!(cur) : undefined),
    fetch: safeFetchFor(acct.provider),
  };
}

const TEST_DEADLINE_MS = 25_000;

/** Runs the provider's read-only health test and records the evidence. Never performs a write. */
export async function testConnector(actorId: string, accountId: string) {
  const acct = await loadOwned(actorId, accountId, "connectors.manage");
  const startedAt = new Date();

  let result: HealthTestResult;
  try {
    const ctx = runtimeContextFor(acct);
    result = await Promise.race([
      getRuntime(acct.provider).healthTest(ctx),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new ConnectorError("provider_unavailable", "Health test timed out")),
          TEST_DEADLINE_MS,
        ),
      ),
    ]);
  } catch (e) {
    const category = e instanceof ConnectorError ? e.category : "provider_unavailable";
    if (category === "auth_expired") await reportAuthFailure(acct.id);
    result = {
      overall: "fail",
      steps: [
        {
          id: "credential",
          label: "Credential validity",
          status: "fail",
          detail: e instanceof ConnectorError ? e.message : "Test could not run",
        },
      ],
    };
  }

  const finishedAt = new Date();
  await getDb().transaction(async (tx) => {
    await tx.insert(connectorTests).values({
      connectorAccountId: acct.id,
      startedByUserId: actorId,
      overall: result.overall,
      steps: result.steps,
      startedAt,
      finishedAt,
    });
    const update: Partial<typeof connectorAccounts.$inferInsert> = {
      lastTestedAt: finishedAt,
      updatedAt: finishedAt,
    };
    if (result.overall === "pass") update.lastSuccessfulTestAt = finishedAt;
    // Truthful transitions: a fully passing test proves the credential works again.
    if (result.overall === "pass" && acct.status === "needs_reauth") update.status = "active";
    if (result.grantedScopes) update.grantedScopes = result.grantedScopes;
    if (result.identity) update.displayName = result.identity.displayName;
    await tx.update(connectorAccounts).set(update).where(eq(connectorAccounts.id, acct.id));
    await recordAudit(
      {
        workspaceId: acct.workspaceId,
        actorType: "user",
        actorId,
        action: "connector.tested",
        subjectType: "connector_account",
        subjectId: acct.id,
        detail: { overall: result.overall },
      },
      tx,
    );
  });
  emit(acct.workspaceId, acct.id, "tested");
  return result;
}

export async function disconnectConnector(actorId: string, accountId: string) {
  const acct = await loadOwned(actorId, accountId, "connectors.manage");
  await revokeConnector(acct.id, "disconnected");
  await recordAudit({
    workspaceId: acct.workspaceId,
    actorType: "user",
    actorId,
    action: "connector.disconnect_requested",
    subjectType: "connector_account",
    subjectId: acct.id,
  });
  emit(acct.workspaceId, acct.id, "disconnected");
}

export type ConnectorView = {
  id: string;
  provider: Provider;
  displayName: string;
  status: "active" | "needs_reauth" | "revoked" | "disconnected";
  /** "degraded" = credentials not known-bad, but the latest test failed. */
  health: "healthy" | "degraded" | "needs_reauth" | "disconnected" | "untested";
  grantedScopes: string[];
  lastTestedAt: Date | null;
  lastSuccessfulTestAt: Date | null;
  latestTest: {
    overall: "pass" | "fail" | "partial";
    steps: { id: string; label: string; status: "pass" | "fail" | "skipped"; detail?: string }[];
    at: Date;
  } | null;
};

/** Safe view: never includes credentials or raw metadata. */
export async function listConnectors(
  actorId: string,
  workspaceId: string,
): Promise<ConnectorView[]> {
  await requirePermission(actorId, workspaceId, "proposals.view");
  const rows = await getDb()
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.workspaceId, workspaceId));
  const out: ConnectorView[] = [];
  for (const a of rows) {
    const [t] = await getDb()
      .select()
      .from(connectorTests)
      .where(eq(connectorTests.connectorAccountId, a.id))
      .orderBy(desc(connectorTests.finishedAt))
      .limit(1);
    const health: ConnectorView["health"] =
      a.status === "needs_reauth"
        ? "needs_reauth"
        : a.status !== "active"
          ? "disconnected"
          : !t
            ? "untested"
            : t.overall === "pass"
              ? "healthy"
              : "degraded";
    out.push({
      id: a.id,
      provider: a.provider,
      displayName: a.displayName,
      status: a.status,
      health,
      grantedScopes: a.grantedScopes,
      lastTestedAt: a.lastTestedAt,
      lastSuccessfulTestAt: a.lastSuccessfulTestAt,
      latestTest: t ? { overall: t.overall, steps: t.steps, at: t.finishedAt } : null,
    });
  }
  return out;
}
