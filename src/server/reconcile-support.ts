import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { executions, proposalVersions, proposals } from "@/db/schema";
import type { ExecutionOutcome } from "@/connectors/types";
import { recordAudit } from "./audit";
import { applyTransition } from "./transitions";

export async function versionOf(proposalId: string, version: number) {
  const [v] = await getDb()
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.version, version)));
  return v ?? null;
}

/**
 * Settles OUTCOME_UNKNOWN → SUCCEEDED after the provider positively confirmed the write. Guarded by
 * a compare-and-set so concurrent reconcilers cannot both apply it.
 */
export async function reconcileToSuccess(
  proposal: typeof proposals.$inferSelect,
  executionId: string,
  outcome: Extract<ExecutionOutcome, { status: "succeeded" }>,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(executions)
      .set({
        state: "SUCCEEDED",
        finishedAt: new Date(),
        providerResult: {
          providerId: outcome.providerId,
          url: outcome.url ?? null,
          ...(outcome.details ?? {}),
        },
        errorCategory: null,
        errorDetail: "Confirmed by reconciliation after an unknown outcome.",
      })
      .where(and(eq(executions.id, executionId), eq(executions.state, "OUTCOME_UNKNOWN")))
      .returning({ id: executions.id });
    if (!updated) return false;
    await applyTransition(proposal.id, "reconcile_success", { actor: { type: "system" } }, tx);
    await recordAudit(
      {
        workspaceId: proposal.workspaceId,
        actorType: "system",
        action: "execution.reconciled",
        subjectType: "proposal",
        subjectId: proposal.id,
        correlationId: proposal.correlationId,
      },
      tx,
    );
    return true;
  });
}
