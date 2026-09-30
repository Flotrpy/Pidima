import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { approvalDecisions, executions, mcpGrants, proposalVersions, proposals } from "@/db/schema";
import { ERROR_GUIDANCE, type ErrorCategory } from "@/connectors/errors";
import { getCapability } from "@/connectors/registry";
import type { McpPrincipal } from "@/mcp/server";
import { isUuid } from "./inbox";
import { logEvent } from "./log";
import { verifyGrantForCall } from "./mcp-grant";
import { expireIfDue, reviewUrl } from "./proposals";
import type { ToolResult } from "./mcp-tools";

const fail = (text: string): ToolResult => ({ isError: true, text });

/** What the AI client should tell the user, and whether polling further is useful. */
export function describeState(
  state: string,
  category?: string | null,
): { text: string; terminal: boolean } {
  switch (state) {
    case "PENDING_APPROVAL":
      return {
        text: "Waiting for a person to review it. Nothing has been done yet.",
        terminal: false,
      };
    case "APPROVED":
      return { text: "Approved by a person. Execution is about to start.", terminal: false };
    case "EXECUTING":
      return { text: "Approved and being carried out now.", terminal: false };
    case "SUCCEEDED":
      return { text: "Approved and completed. The provider confirmed the result.", terminal: true };
    case "FAILED":
      return {
        text:
          category && category in ERROR_GUIDANCE
            ? `It did not complete: ${ERROR_GUIDANCE[category as ErrorCategory].title}. ${ERROR_GUIDANCE[category as ErrorCategory].recovery}`
            : "It did not complete.",
        terminal: true,
      };
    case "OUTCOME_UNKNOWN":
      return {
        text: "The provider did not confirm whether it was carried out. A person needs to verify before anything is retried. Do not propose it again yet.",
        terminal: false,
      };
    case "DENIED":
      return { text: "A person denied it. Nothing was done.", terminal: true };
    case "CANCELED":
      return { text: "It was withdrawn. Nothing was done.", terminal: true };
    case "EXPIRED":
      return {
        text: "It expired before anyone decided. Nothing was done. You may propose it again.",
        terminal: true,
      };
    default:
      return { text: "Unknown state.", terminal: false };
  }
}

/**
 * Proposals visible to this caller: created by the same AI client, for the same user, in the
 * same workspace. Never other users', other clients', or other workspaces'.
 */
async function visibleGrantIds(grant: {
  mcpClientId: string;
  userId: string;
  workspaceId: string;
}): Promise<string[]> {
  const rows = await getDb()
    .select({ id: mcpGrants.id })
    .from(mcpGrants)
    .where(
      and(
        eq(mcpGrants.mcpClientId, grant.mcpClientId),
        eq(mcpGrants.userId, grant.userId),
        eq(mcpGrants.workspaceId, grant.workspaceId),
      ),
    );
  return rows.map((r) => r.id);
}

export async function getStatusTool(
  principal: McpPrincipal,
  input: { proposal_id?: unknown },
  authClientId?: string,
): Promise<ToolResult> {
  const g = await verifyGrantForCall(principal, "proposals:read", authClientId);
  if (!g.ok) return fail(g.text);
  const id = typeof input.proposal_id === "string" ? input.proposal_id : "";
  // Same answer for malformed, missing, and not-yours.
  const notFound = fail("No proposal with that ID was found for this client.");
  if (!isUuid(id)) return notFound;

  await expireIfDue(id).catch(() => false);
  const grantIds = await visibleGrantIds(g.v.grant);
  const [p] = await getDb()
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.id, id),
        eq(proposals.workspaceId, g.v.grant.workspaceId),
        inArray(proposals.mcpGrantId, grantIds),
      ),
    );
  if (!p) return notFound;

  const def = getCapability(p.capability)!;
  const [version] = await getDb()
    .select()
    .from(proposalVersions)
    .where(
      and(eq(proposalVersions.proposalId, p.id), eq(proposalVersions.version, p.currentVersion)),
    );
  const [exec] = await getDb()
    .select()
    .from(executions)
    .where(eq(executions.proposalId, p.id))
    .orderBy(desc(executions.startedAt))
    .limit(1);
  const decisions = await getDb()
    .select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.proposalId, p.id))
    .orderBy(desc(approvalDecisions.createdAt));
  const last = decisions.find((d) => d.decision !== "edit");
  const edited = decisions.some((d) => d.decision === "edit");
  const desc_ = describeState(p.state, exec?.errorCategory);

  const structured: Record<string, unknown> = {
    proposal_id: p.id,
    state: p.state,
    status_text: desc_.text,
    terminal: desc_.terminal,
    summary: version ? def.safeSummary(version.args as never) : def.title,
    version: p.currentVersion,
    edited_by_human: edited,
    created_at: p.createdAt.toISOString(),
    expires_at: p.expiresAt.toISOString(),
    review_url: reviewUrl(p.id),
    ...(last
      ? {
          decision:
            last.decision === "approve"
              ? "approved"
              : last.decision === "deny"
                ? "denied"
                : "canceled",
          decided_at: last.createdAt.toISOString(),
        }
      : {}),
    ...(exec
      ? {
          execution: {
            state: exec.state,
            finished_at: exec.finishedAt?.toISOString() ?? null,
            ...(exec.state === "SUCCEEDED" && exec.providerResult
              ? {
                  result_url: (exec.providerResult as { url?: string | null }).url ?? null,
                  result_id: (exec.providerResult as { providerId?: string }).providerId ?? null,
                }
              : {}),
            ...(exec.errorCategory ? { error_category: exec.errorCategory } : {}),
          },
        }
      : {}),
  };
  logEvent("mcp.tool.status", {
    workspaceId: p.workspaceId,
    grantId: g.v.grant.id,
    proposalId: p.id,
    state: p.state,
  });
  return {
    isError: false,
    structured,
    text: `${def.title} proposal ${p.id}: ${p.state}. ${desc_.text}`,
  };
}

export async function listRecentTool(
  principal: McpPrincipal,
  input: { limit?: unknown; state?: unknown },
  authClientId?: string,
): Promise<ToolResult> {
  const g = await verifyGrantForCall(principal, "proposals:read", authClientId);
  if (!g.ok) return fail(g.text);
  const limit = Math.min(
    20,
    Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : 10),
  );
  const grantIds = await visibleGrantIds(g.v.grant);
  const states = typeof input.state === "string" ? [input.state] : null;
  const rows = await getDb()
    .select({ p: proposals, v: proposalVersions })
    .from(proposals)
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.proposalId, proposals.id),
        eq(proposalVersions.version, proposals.currentVersion),
      ),
    )
    .where(
      and(
        eq(proposals.workspaceId, g.v.grant.workspaceId),
        inArray(proposals.mcpGrantId, grantIds),
        states ? inArray(proposals.state, states as never) : undefined,
      ),
    )
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
    .limit(limit);
  const items = rows.map(({ p, v }) => ({
    proposal_id: p.id,
    capability: p.capability,
    summary: getCapability(p.capability)!.safeSummary(v.args as never),
    state: p.state,
    created_at: p.createdAt.toISOString(),
    expires_at: p.expiresAt.toISOString(),
  }));
  return {
    isError: false,
    structured: { proposals: items, count: items.length },
    text:
      items.length === 0
        ? "No proposals found."
        : items.map((i) => `${i.proposal_id}: ${i.summary} (${i.state})`).join("\n"),
  };
}
