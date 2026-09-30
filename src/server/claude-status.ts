import "server-only";
import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpGrants, proposals } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import { requirePermission } from "./authz";

export type GatewayCheck = { reachable: boolean; detail: string };

/**
 * Fetches this deployment's own public metadata URL, which exercises DNS, TLS and routing the
 * way an external client would. It only ever contacts APP_URL and never follows redirects.
 */
export async function checkGatewayReachable(
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayCheck> {
  const url = protectedResourceMetadataUrl();
  if (new URL(url).origin !== new URL(getEnv().APP_URL).origin)
    return { reachable: false, detail: "Unexpected origin" };
  try {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (!res.ok)
      return { reachable: false, detail: `The endpoint answered with status ${res.status}.` };
    const doc = (await res.json()) as { resource?: string };
    if (doc.resource !== mcpResourceUrl())
      return {
        reachable: false,
        detail: "The endpoint answered, but it advertises a different resource URL. Check APP_URL.",
      };
    return {
      reachable: true,
      detail: "The gateway answered with the expected discovery document.",
    };
  } catch {
    return {
      reachable: false,
      detail: "The gateway could not be reached at its public URL. Check APP_URL, DNS and TLS.",
    };
  }
}

export type ClaudeStatus = {
  endpointUrl: string;
  gateway: GatewayCheck;
  /** An MCP client holds a live authorization for this workspace. */
  authorized: { done: boolean; clientNames: string[] };
  /** A request carrying a valid token has reached the gateway. */
  activityObserved: { done: boolean; lastAt: Date | null };
  /** A client-originated proposal exists: the whole path worked. */
  proposalReceived: { done: boolean; lastAt: Date | null; count: number };
};

/** Four separate facts. None implies another, and none claims a "live connection". */
export async function getClaudeStatus(
  actorId: string,
  workspaceId: string,
  fetchImpl?: typeof fetch,
): Promise<ClaudeStatus> {
  await requirePermission(actorId, workspaceId, "clients.connect");
  const db = getDb();
  const grants = await db
    .select()
    .from(mcpGrants)
    .where(and(eq(mcpGrants.workspaceId, workspaceId), isNull(mcpGrants.revokedAt)));
  const names = await db.query.mcpClients.findMany({ columns: { id: true, name: true } });
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  const lastActivity =
    grants
      .map((g) => g.lastActivityAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const [counted] = await db
    .select({ n: count() })
    .from(proposals)
    .where(and(eq(proposals.workspaceId, workspaceId), isNotNull(proposals.mcpGrantId)));
  const [latest] = await db
    .select({ at: proposals.createdAt })
    .from(proposals)
    .where(and(eq(proposals.workspaceId, workspaceId), isNotNull(proposals.mcpGrantId)))
    .orderBy(desc(proposals.createdAt))
    .limit(1);
  return {
    endpointUrl: mcpResourceUrl(),
    gateway: await checkGatewayReachable(fetchImpl),
    authorized: {
      done: grants.length > 0,
      clientNames: [...new Set(grants.map((g) => nameById.get(g.mcpClientId) ?? "AI client"))],
    },
    activityObserved: { done: lastActivity !== null, lastAt: lastActivity },
    proposalReceived: {
      done: (counted?.n ?? 0) > 0,
      lastAt: latest?.at ?? null,
      count: counted?.n ?? 0,
    },
  };
}
