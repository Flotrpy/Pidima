import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { approvalDecisions, executionAttempts, executions, proposals } from "@/db/schema";
import type { ErrorCategory } from "@/connectors/errors";
import type { ExecutionOutcome } from "@/connectors/types";
import { recordAudit, type Executor } from "./audit";
import { applyTransition } from "./transitions";
import { getVersion, type VersionRow } from "./versions";

export type Claim = {
  executionId: string;
  proposal: typeof proposals.$inferSelect;
  version: VersionRow;
  /** Stable per approved version: retries against a provider that supports idempotency dedupe. */
  idempotencyKey: string;
  approvedByUserId: string;
};

/** Deterministic, so a crash-and-retry (by a human, after verification) reuses the same key. */
export const idempotencyKeyFor = (proposalVersionId: string) =>
  createHash("sha256")
    .update(`ai-action-inbox:exec:${proposalVersionId}`)
    .digest("hex")
    .slice(0, 40);

/**
 * Atomically claims an APPROVED proposal for execution, or returns null if another worker (or an
 * earlier run) already did. Three independent guards:
 *   1. row lock + state check (only APPROVED can move to EXECUTING),
 *   2. compare-and-set state transition plus the database state guard,
 *   3. UNIQUE(executions.proposal_version_id): a second execution row cannot exist.
 * No in-memory lock is involved, so it holds across processes and restarts.
 */
export async function claimExecution(
  proposalId: string,
  instanceId: string,
): Promise<Claim | null> {
  return getDb().transaction(async (tx) => {
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId)).for("update");
    if (!p || p.state !== "APPROVED") return null;

    const version = await getVersion(tx, p.id, p.currentVersion);
    const [approval] = version
      ? await tx
          .select()
          .from(approvalDecisions)
          .where(
            and(
              eq(approvalDecisions.proposalVersionId, version.id),
              eq(approvalDecisions.decision, "approve"),
            ),
          )
      : [];
    // Only the exact version that a person approved may run.
    if (!version || !approval) return null;

    const key = idempotencyKeyFor(version.id);
    const inserted = await tx
      .insert(executions)
      .values({
        proposalVersionId: version.id,
        proposalId: p.id,
        claimedBy: instanceId,
        idempotencyKey: key,
      })
      .onConflictDoNothing({ target: executions.proposalVersionId })
      .returning();
    if (inserted.length === 0) return null;

    await applyTransition(p.id, "claim", { actor: { type: "system", id: instanceId } }, tx);
    await recordAudit(
      {
        workspaceId: p.workspaceId,
        actorType: "system",
        actorId: instanceId,
        action: "execution.claimed",
        subjectType: "proposal",
        subjectId: p.id,
        correlationId: p.correlationId,
      },
      tx,
    );
    return {
      executionId: inserted[0]!.id,
      proposal: { ...p, state: "EXECUTING" },
      version,
      idempotencyKey: key,
      approvedByUserId: approval.decidedByUserId,
    };
  });
}

/** Marks that a request is about to leave for the provider. After this point the outcome may be unknown. */
export async function recordDispatchAttempt(executionId: string, exec: Executor = getDb()) {
  const [a] = await exec
    .insert(executionAttempts)
    .values({ executionId, attemptNo: 1 })
    .onConflictDoNothing()
    .returning();
  return a ?? null;
}

const CATEGORY_OUTCOME: Record<"failed" | "unknown", "failure" | "unknown"> = {
  failed: "failure",
  unknown: "unknown",
};

/**
 * Records the terminal result exactly once. The execution row is only updated while still
 * EXECUTING, so a late or duplicate finalize cannot overwrite an earlier outcome.
 */
export async function finalizeExecution(
  claim: Pick<Claim, "executionId" | "proposal">,
  outcome: ExecutionOutcome | { status: "failed"; category: ErrorCategory; message: string },
) {
  return getDb().transaction(async (tx) => {
    const state =
      outcome.status === "succeeded"
        ? "SUCCEEDED"
        : outcome.status === "failed"
          ? "FAILED"
          : "OUTCOME_UNKNOWN";
    const [updated] = await tx
      .update(executions)
      .set({
        state,
        finishedAt: new Date(),
        providerResult:
          outcome.status === "succeeded"
            ? {
                providerId: outcome.providerId,
                url: outcome.url ?? null,
                ...(outcome.details ?? {}),
              }
            : null,
        errorCategory:
          outcome.status === "failed"
            ? outcome.category
            : outcome.status === "unknown"
              ? "verification_required"
              : null,
        errorDetail:
          outcome.status === "failed"
            ? outcome.message.slice(0, 300)
            : outcome.status === "unknown"
              ? outcome.reason.slice(0, 300)
              : null,
      })
      .where(and(eq(executions.id, claim.executionId), eq(executions.state, "EXECUTING")))
      .returning();
    if (!updated) return false;

    await tx
      .update(executionAttempts)
      .set({
        finishedAt: new Date(),
        outcome: outcome.status === "succeeded" ? "success" : CATEGORY_OUTCOME[outcome.status],
        errorCategory:
          outcome.status === "failed"
            ? outcome.category
            : outcome.status === "unknown"
              ? "verification_required"
              : null,
      })
      .where(
        and(
          eq(executionAttempts.executionId, claim.executionId),
          isNull(executionAttempts.finishedAt),
        ),
      );

    const event =
      outcome.status === "succeeded"
        ? "succeed"
        : outcome.status === "failed"
          ? "fail"
          : "mark_unknown";
    await applyTransition(
      claim.proposal.id,
      event,
      {
        actor: { type: "system" },
        detail: { category: outcome.status === "failed" ? outcome.category : undefined },
      },
      tx,
    );
    await recordAudit(
      {
        workspaceId: claim.proposal.workspaceId,
        actorType: "system",
        action: `execution.${outcome.status}`,
        subjectType: "proposal",
        subjectId: claim.proposal.id,
        correlationId: claim.proposal.correlationId,
        detail: { category: outcome.status === "failed" ? outcome.category : undefined },
      },
      tx,
    );
    return true;
  });
}

/**
 * Crash recovery. A claim that never reached "dispatch attempted" provably sent nothing and
 * fails safe. One that did may have been accepted, so it becomes OUTCOME_UNKNOWN: it is never
 * dispatched again automatically.
 */
export async function recoverStuckExecutions(
  olderThanMs = 5 * 60_000,
  now = new Date(),
): Promise<{ failedBeforeDispatch: number; unknown: number }> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stuck = await getDb()
    .select({ e: executions, p: proposals })
    .from(executions)
    .innerJoin(proposals, eq(proposals.id, executions.proposalId))
    .where(and(eq(executions.state, "EXECUTING"), lt(executions.startedAt, cutoff)));
  let failedBeforeDispatch = 0;
  let unknown = 0;
  for (const { e, p } of stuck) {
    const attempts = await getDb()
      .select({ id: executionAttempts.id })
      .from(executionAttempts)
      .where(eq(executionAttempts.executionId, e.id));
    const claim = { executionId: e.id, proposal: p };
    const ok =
      attempts.length === 0
        ? await finalizeExecution(claim, {
            status: "failed",
            category: "failed_before_dispatch",
            message: "The worker stopped before contacting the provider. Nothing was sent.",
          })
        : await finalizeExecution(claim, {
            status: "unknown",
            reason:
              "The worker stopped after the request was sent; the provider may have accepted it.",
          });
    if (ok) attempts.length === 0 ? failedBeforeDispatch++ : unknown++;
  }
  return { failedBeforeDispatch, unknown };
}

/** APPROVED proposals with no execution yet (e.g. the in-process notification was lost). */
export async function findUnclaimedApproved(limit = 50): Promise<string[]> {
  const rows = await getDb().execute<{ id: string }>(
    sql`select p.id from proposals p where p.state = 'APPROVED' and not exists (select 1 from executions e where e.proposal_id = p.id) order by p.updated_at limit ${limit}`,
  );
  return rows.rows.map((r) => r.id);
}
