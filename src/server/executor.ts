import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, executionAttempts, executions, proposals } from "@/db/schema";
import { ConnectorError, type ErrorCategory } from "@/connectors/errors";
import { initConnectors } from "@/connectors/init";
import { getCapability, getRuntime } from "@/connectors/registry";
import type { ExecutionOutcome } from "@/connectors/types";
import { hostname } from "node:os";
import { onProposalApproved } from "./decisions";
import { notifyExecutionOutcome } from "./notifications";
import { purgeExpiredAuditEvents } from "./activity";
import { purgeOldBuckets } from "./rate-limit";
import { backfillMissingReceipts } from "./receipts";
import {
  claimExecution,
  findUnclaimedApproved,
  finalizeExecution,
  recordDispatchAttempt,
  recoverStuckExecutions,
  type Claim,
} from "./execution-claim";
import { runtimeContextFor } from "./connectors";
import { reportAuthFailure } from "./credentials";
import { reconcileToSuccess, versionOf } from "./reconcile-support";
import { logEvent } from "./log";
import { evaluateForProposal } from "./policy";
import { expireIfDue } from "./proposals";
import { IntegrityError, assertVersionIntegrity } from "./versions";

initConnectors();

export const INSTANCE_ID = `${hostname()}:${process.pid}`;
/** Hard ceiling on one provider call. Past this the outcome is unknown, not failed. */
export const DISPATCH_DEADLINE_MS = 30_000;

export type ExecutionResult =
  | { status: "skipped"; reason: "not_claimable" | "expired" }
  | { status: "done"; outcome: ExecutionOutcome["status"]; executionId: string };

/** Policy denial reason → user-facing failure category. */
function categoryForReasons(codes: string[]): ErrorCategory {
  if (codes.includes("proposal_expired")) return "proposal_expired";
  if (codes.includes("connector_inactive") || codes.includes("connector_missing"))
    return "auth_expired";
  if (codes.includes("scope_missing")) return "scope_missing";
  return "policy_changed";
}

/**
 * Executes one approved proposal at most once. Every step before "dispatch attempted" is safe to
 * abandon (nothing was sent); every step after treats uncertainty as OUTCOME_UNKNOWN and never
 * retries the write.
 */
export async function executeApprovedProposal(
  proposalId: string,
  opts: { instanceId?: string } = {},
): Promise<ExecutionResult> {
  const instanceId = opts.instanceId ?? INSTANCE_ID;
  if (await expireIfDue(proposalId)) return { status: "skipped", reason: "expired" };

  const claim = await claimExecution(proposalId, instanceId);
  if (!claim) return { status: "skipped", reason: "not_claimable" };

  const started = Date.now();
  const outcome = await runClaim(claim);
  await finalizeExecution(claim, outcome);
  // A definitive "your token is dead" answer must be visible in the UI, not just on this proposal.
  if (outcome.status === "failed" && outcome.category === "auth_expired")
    await reportAuthFailure(claim.proposal.connectorAccountId);
  if (outcome.status !== "succeeded")
    await notifyExecutionOutcome(
      claim.proposal.id,
      outcome.status === "failed" ? "failed" : "unknown",
    ).catch(() => undefined);
  logEvent("execution.finished", {
    workspaceId: claim.proposal.workspaceId,
    proposalId: claim.proposal.id,
    executionId: claim.executionId,
    capability: claim.proposal.capability,
    outcome: outcome.status,
    category: outcome.status === "failed" ? outcome.category : undefined,
    durationMs: Date.now() - started,
  });
  return { status: "done", outcome: outcome.status, executionId: claim.executionId };
}

async function runClaim(claim: Claim): Promise<ExecutionOutcome> {
  const { proposal, version } = claim;
  const before = (
    message: string,
    category: ErrorCategory = "failed_before_dispatch",
  ): ExecutionOutcome => ({ status: "failed", category, message });
  try {
    // 1. The stored content must still be exactly what was hashed and approved.
    try {
      assertVersionIntegrity(proposal, version);
    } catch (e) {
      if (e instanceof IntegrityError)
        return before(
          "The proposal content no longer matches what was approved. Nothing was sent.",
        );
      throw e;
    }

    // 2. Re-evaluate permissions, connector state, provider scopes and destination policy right now.
    const args = version.args as Record<string, unknown>;
    const policy = await evaluateForProposal("execute", proposal, args);
    if (!policy.allowed)
      return before(
        `Not executed: ${policy.reasons.map((r) => r.message).join(" ")}`,
        categoryForReasons(policy.reasons.map((r) => r.code)),
      );

    // 3. Provider-side pre-flight (read-only): is the destination still valid?
    const [account] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, proposal.connectorAccountId));
    if (!account || account.status !== "active" || account.workspaceId !== proposal.workspaceId)
      return before("The connected account is no longer active.", "auth_expired");
    const runtime = getRuntime(account.provider);
    const ctx = runtimeContextFor(account);
    if (runtime.validateProposal) {
      const v = await runtime.validateProposal(ctx, proposal.capability, args);
      if (v.status === "rejected") return before(v.message, v.category);
    }

    // 4. Point of no return: from here the provider may have received the request.
    await recordDispatchAttempt(claim.executionId);
    const dispatch = runtime.execute(ctx, proposal.capability, args, {
      idempotencyKey: claim.idempotencyKey,
      proposalId: proposal.id,
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ExecutionOutcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            status: "unknown",
            reason: "The provider did not answer within the time limit.",
          }),
        DISPATCH_DEADLINE_MS,
      );
    });
    try {
      // If the deadline wins, the call may still complete later; reconciliation settles it.
      return await Promise.race([dispatch, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e instanceof ConnectorError) {
      // Errors before dispatch are safe failures; anything ambiguous after it is unknown.
      return e.maybeDispatched
        ? { status: "unknown", reason: e.message }
        : { status: "failed", category: e.category, message: e.message };
    }
    const attempted =
      (
        await getDb()
          .select({ id: executionAttempts.id })
          .from(executionAttempts)
          .where(eq(executionAttempts.executionId, claim.executionId))
      ).length > 0;
    return attempted
      ? { status: "unknown", reason: "An unexpected error occurred after the request was sent." }
      : before("An unexpected error occurred before anything was sent.");
  }
}

// ---------- Reconciliation ----------

/**
 * Tries to settle OUTCOME_UNKNOWN proposals where the provider offers a reliable lookup. Only a
 * positive finding changes state (to SUCCEEDED); an inconclusive lookup leaves it unknown for a person.
 */
export async function reconcileUnknownOutcomes(
  limit = 25,
): Promise<{ resolved: number; inconclusive: number }> {
  const rows = await getDb()
    .select({ p: proposals, e: executions })
    .from(proposals)
    .innerJoin(executions, eq(executions.proposalId, proposals.id))
    .where(and(eq(proposals.state, "OUTCOME_UNKNOWN"), eq(executions.state, "OUTCOME_UNKNOWN")))
    .limit(limit);
  let resolved = 0;
  let inconclusive = 0;
  for (const { p, e } of rows) {
    const [account] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, p.connectorAccountId));
    const runtime = account ? getRuntime(account.provider) : null;
    if (!account || !runtime?.reconcile) {
      inconclusive++;
      continue;
    }
    const version = await versionOf(p.id, p.currentVersion);
    const outcome = await runtime.reconcile(
      runtimeContextFor(account),
      p.capability,
      (version?.args ?? {}) as Record<string, unknown>,
      {
        idempotencyKey: e.idempotencyKey,
        proposalId: p.id,
        since: new Date(e.startedAt.getTime() - 60_000),
      },
    );
    if (outcome?.status === "succeeded") {
      if (await reconcileToSuccess(p, e.id, outcome)) resolved++;
    } else inconclusive++;
  }
  return { resolved, inconclusive };
}

// ---------- Wiring and maintenance ----------

let stopExecutor: (() => void) | null = null;
/**
 * Starts in-process execution on approval (idempotent). Returns a stop function so tests, and
 * graceful shutdown, can unsubscribe. The maintenance sweep covers anything a stopped listener missed.
 */
export function startExecutor(): () => void {
  if (!stopExecutor) {
    const off = onProposalApproved(async ({ proposalId }) => {
      await executeApprovedProposal(proposalId);
    });
    stopExecutor = () => {
      off();
      stopExecutor = null;
    };
  }
  return stopExecutor;
}

/** Scheduled maintenance: pick up anything missed, settle crashed runs, reconcile what can be reconciled. */
export async function runExecutionMaintenance() {
  const recovered = await recoverStuckExecutions();
  let dispatched = 0;
  for (const id of await findUnclaimedApproved()) {
    const r = await executeApprovedProposal(id).catch(() => null);
    if (r?.status === "done") dispatched++;
  }
  const reconciled = await reconcileUnknownOutcomes();
  const receipts = await backfillMissingReceipts();
  const auditPurged = await purgeExpiredAuditEvents(
    Number(process.env.AUDIT_RETENTION_DAYS) || undefined,
  ).catch(() => 0);
  const bucketsPurged = await purgeOldBuckets().catch(() => 0);
  return { recovered, dispatched, reconciled, receipts, auditPurged, bucketsPurged };
}
