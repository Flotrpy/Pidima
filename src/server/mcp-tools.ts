import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants } from "@/db/schema";
import { toProposalArgs } from "@/mcp/tool-defs";
import type { McpPrincipal } from "@/mcp/server";
import type { Capability } from "@/lib/permissions";
import { can } from "@/lib/permissions";
import { loadMembership } from "./authz";
import { availableCapabilities } from "./policy";
import { ProposalError, createProposal } from "./proposals";
import { logEvent } from "./log";

export type ToolResult = { isError: boolean; text: string; structured?: Record<string, unknown> };

const fail = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  isError: true,
  text,
  structured,
});

/**
 * Trust boundary for every proposal tool call. Nothing from discovery, the session, or the
 * closure that built the server is trusted: the grant, its client, the workspace, the user's
 * current rights and the capability are all re-read and re-checked here, on each call.
 */
export async function callProposeTool(
  principal: McpPrincipal,
  capability: Capability,
  input: Record<string, unknown>,
  authClientId?: string,
): Promise<ToolResult> {
  const correlationId = randomUUID();
  const started = Date.now();
  try {
    const [row] = await getDb()
      .select({ grant: mcpGrants, clientId: mcpClients.clientId, clientName: mcpClients.name })
      .from(mcpGrants)
      .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.mcpClientId))
      .where(eq(mcpGrants.id, principal.grantId));

    // 1. Grant must exist, be live, belong to the token's client, and match the workspace we were built for.
    if (
      !row ||
      row.grant.revokedAt ||
      row.grant.workspaceId !== principal.workspaceId ||
      row.grant.userId !== principal.userId
    ) {
      return fail(
        "This AI client authorization is no longer valid. Reconnect it in AI Action Inbox.",
      );
    }
    if (authClientId && authClientId !== row.clientId)
      return fail(
        "This AI client authorization is no longer valid. Reconnect it in AI Action Inbox.",
      );
    // 2. Scope.
    if (!row.grant.scopes.includes("proposals:create"))
      return fail("This AI client was not authorized to propose actions.");
    // 3. The authorizing user must still be allowed to connect clients in this workspace.
    const m = await loadMembership(row.grant.userId, row.grant.workspaceId);
    if (!m || !can(m.role, "clients.connect"))
      return fail("The person who authorized this client no longer has access.");
    // 4. Capability must currently be offered (policy + connector), independent of what tools/list showed earlier.
    if (!(await availableCapabilities(row.grant.id)).includes(capability)) {
      return fail(
        "This action type is not currently available. An owner may need to enable it or connect the service.",
      );
    }

    // 5. Schema, connector ownership and full policy are validated inside createProposal.
    const clientRequestId =
      typeof input.client_request_id === "string" ? input.client_request_id : undefined;
    const connectorAccountId =
      typeof input.connector_account_id === "string" ? input.connector_account_id : undefined;
    const r = await createProposal({
      principal: {
        grantId: row.grant.id,
        userId: row.grant.userId,
        workspaceId: row.grant.workspaceId,
        clientLabel: row.clientName,
      },
      capability,
      args: toProposalArgs(capability, input),
      connectorAccountId,
      clientRequestId,
    });

    logEvent("mcp.tool.proposed", {
      correlationId,
      workspaceId: row.grant.workspaceId,
      grantId: row.grant.id,
      capability,
      proposalId: r.proposalId,
      durationMs: Date.now() - started,
      duplicate: r.duplicate,
    });
    const structured = {
      proposal_id: r.proposalId,
      state: r.state,
      summary: r.summary,
      expires_at: r.expiresAt.toISOString(),
      review_url: r.reviewUrl,
      version: r.version,
    };
    return {
      isError: false,
      structured,
      text: `Proposal ${r.proposalId} is ${r.state.toLowerCase().replace("_", " ")}. ${r.summary}. Nothing has been done yet: a person must review and approve it at ${r.reviewUrl} before ${new Date(r.expiresAt).toISOString()}. Use action.get_status with this proposal ID to follow it.`,
    };
  } catch (e) {
    if (e instanceof ProposalError) {
      logEvent("mcp.tool.rejected", {
        correlationId,
        workspaceId: principal.workspaceId,
        grantId: principal.grantId,
        capability,
        code: e.code,
        durationMs: Date.now() - started,
      });
      if (e.code === "invalid_arguments")
        return fail(
          `The arguments were invalid. Fix these and try again: ${JSON.stringify(e.details.issues)}`,
          { code: e.code },
        );
      if (e.code === "policy_denied")
        return fail(
          `Workspace policy does not allow this: ${(e.details.reasons as { message: string }[]).map((r) => r.message).join(" ")}`,
          { code: e.code },
        );
      if (e.code === "connector_ambiguous")
        return fail(`${e.message} Options: ${JSON.stringify(e.details.accounts)}`, {
          code: e.code,
        });
      return fail(e.message, { code: e.code });
    }
    logEvent("mcp.tool.error", {
      correlationId,
      workspaceId: principal.workspaceId,
      grantId: principal.grantId,
      capability,
      durationMs: Date.now() - started,
    });
    return fail(
      `The request could not be processed. Nothing was created. Reference: ${correlationId}`,
    );
  }
}
