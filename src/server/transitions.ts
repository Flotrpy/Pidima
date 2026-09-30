import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { proposals } from "@/db/schema";
import { InvalidTransitionError, nextState, type ProposalEvent } from "@/approvals/state-machine";
import type { ProposalState } from "@/components/ui/status";
import { recordAudit, type Executor } from "./audit";
import { writeReceiptForState } from "./receipts";

export class StaleStateError extends Error {
  constructor() {
    super("The proposal changed while you were working on it. Reload and try again.");
  }
}

/**
 * Compare-and-set transition. The UPDATE only matches if the row is still in the state we
 * computed the transition from, so concurrent decisions cannot both win. The database trigger
 * independently rejects any pair not in the table.
 */
export async function applyTransition(
  proposalId: string,
  event: ProposalEvent,
  opts: {
    actor?: { type: "user" | "mcp_client" | "system"; id?: string };
    detail?: Record<string, unknown>;
    extra?: Partial<typeof proposals.$inferInsert>;
  } = {},
  exec: Executor = getDb(),
): Promise<{ from: ProposalState; to: ProposalState }> {
  const [current] = await exec
    .select({ state: proposals.state, workspaceId: proposals.workspaceId })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  if (!current) throw new StaleStateError();
  const from = current.state as ProposalState;
  const to = nextState(from, event); // throws InvalidTransitionError

  const updated = await exec
    .update(proposals)
    .set({ ...opts.extra, state: to, updatedAt: new Date() })
    .where(and(eq(proposals.id, proposalId), eq(proposals.state, from)))
    .returning({ id: proposals.id });
  if (updated.length === 0) throw new StaleStateError();

  await recordAudit(
    {
      workspaceId: current.workspaceId,
      actorType: opts.actor?.type ?? "system",
      actorId: opts.actor?.id ?? null,
      action: `proposal.${event}`,
      subjectType: "proposal",
      subjectId: proposalId,
      detail: { from, to, ...opts.detail },
    },
    exec,
  );
  // Settling states get their receipt in the same transaction, so a receipt exists iff the state does.
  if (to !== from) await writeReceiptForState(exec, proposalId, to, from);
  return { from, to };
}

export { InvalidTransitionError };
