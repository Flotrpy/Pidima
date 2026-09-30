import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants } from "@/db/schema";
import { can } from "@/lib/permissions";
import type { McpPrincipal } from "@/mcp/server";
import type { McpScope } from "@/mcp/scopes";
import { loadMembership } from "./authz";

const INVALID = "This AI client authorization is no longer valid. Reconnect it in AI Action Inbox.";

export type VerifiedGrant = {
  grant: typeof mcpGrants.$inferSelect;
  clientId: string;
  clientName: string;
};

/**
 * Re-reads and re-checks everything an MCP call depends on. Called at the start of EVERY tool
 * call; nothing established earlier in the request (or by tool discovery) is trusted.
 */
export async function verifyGrantForCall(
  principal: McpPrincipal,
  scope: McpScope,
  authClientId?: string,
): Promise<{ ok: true; v: VerifiedGrant } | { ok: false; text: string }> {
  const [row] = await getDb()
    .select({ grant: mcpGrants, clientId: mcpClients.clientId, clientName: mcpClients.name })
    .from(mcpGrants)
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.mcpClientId))
    .where(eq(mcpGrants.id, principal.grantId));

  // Live, belongs to the token's client, and matches the workspace and user this server was built for.
  if (
    !row ||
    row.grant.revokedAt ||
    row.grant.workspaceId !== principal.workspaceId ||
    row.grant.userId !== principal.userId
  )
    return { ok: false, text: INVALID };
  if (authClientId && authClientId !== row.clientId) return { ok: false, text: INVALID };
  if (!row.grant.scopes.includes(scope))
    return {
      ok: false,
      text:
        scope === "proposals:create"
          ? "This AI client was not authorized to propose actions."
          : "This AI client was not authorized to read proposal status.",
    };
  const m = await loadMembership(row.grant.userId, row.grant.workspaceId);
  if (!m || !can(m.role, "clients.connect"))
    return { ok: false, text: "The person who authorized this client no longer has access." };
  return { ok: true, v: row };
}
