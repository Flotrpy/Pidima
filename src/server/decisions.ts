import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { approvalDecisions, proposals } from "@/db/schema";
import { canDecide, can } from "@/lib/permissions";
import type { ProposalState } from "@/components/ui/status";
import { recordAudit } from "./audit";
import { loadMembership } from "./authz";
import { evaluateForProposal } from "./policy";
import { expireIfDue } from "./proposals";
import { applyTransition } from "./transitions";
import { IntegrityError, assertVersionIntegrity, getVersion } from "./versions";

export class DecisionError extends Error {
  constructor(
    public code:
      "not_found" | "forbidden" | "not_pending" | "conflict" | "policy_denied" | "integrity",
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type DecisionResult = {
  status:
    "approved" | "denied" | "canceled" | "already_approved" | "already_denied" | "already_canceled";
  state: ProposalState;
  version: number;
};

type ApprovedListener = (e: { proposalId: string; workspaceId: string }) => void | Promise<void>;
const approvedListeners = new Set<ApprovedListener>();
/** The executor subscribes here. Approval itself never contacts a provider. */
export function onProposalApproved(fn: ApprovedListener) {
  approvedListeners.add(fn);
  return () => approvedListeners.delete(fn);
}
async function notifyApproved(proposalId: string, workspaceId: string) {
  for (const l of approvedListeners) {
    try {
      await l({ proposalId, workspaceId });
    } catch {
      /* the recovery sweep picks up anything a listener missed */
    }
  }
}

const AUDIT_ACTION = {
  approve: "proposal.approved",
  deny: "proposal.denied",
  cancel: "proposal.canceled",
} as const;

type Input = {
  actorId: string;
  workspaceId: string;
  proposalId: string;
  decision: "approve" | "deny" | "cancel";
  expectedVersion: number;
  reason?: string;
};

/**
 * Records one human decision on one immutable version. The row lock plus compare-and-set means
 * concurrent or repeated requests cannot produce two outcomes; repeats return the existing state.
 */
export async function decideProposal(input: Input): Promise<DecisionResult> {
  const m = await loadMembership(input.actorId, input.workspaceId);
  if (!m) throw new DecisionError("not_found", "Proposal not found");
  await expireIfDue(input.proposalId);

  const [p0] = await getDb()
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, input.proposalId), eq(proposals.workspaceId, input.workspaceId)));
  if (!p0) throw new DecisionError("not_found", "Proposal not found");
  if (!can(m.role, "proposals.view"))
    throw new DecisionError("forbidden", "You do not have access to this proposal.");

  const isRequester = p0.initiatedByUserId === input.actorId;
  if (input.decision === "cancel") {
    // The requester may withdraw their own request; deciders may cancel any.
    if (!isRequester && !canDecide(m.role, m.approvalCapabilities, p0.capability))
      throw new DecisionError("forbidden", "Only the requester or an approver can cancel this.");
  } else if (!canDecide(m.role, m.approvalCapabilities, p0.capability)) {
    throw new DecisionError("forbidden", "You are not allowed to decide this type of action.");
  }

  const result = await getDb().transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, input.proposalId))
      .for("update");
    if (!p) throw new DecisionError("not_found", "Proposal not found");
    const state = p.state as ProposalState;
    const version = await getVersion(tx, p.id, p.currentVersion);
    if (!version) throw new DecisionError("not_found", "Proposal not found");

    // Idempotent repeats: same decision already recorded for the version the caller was looking at.
    if (input.expectedVersion === p.currentVersion) {
      if (
        input.decision === "approve" &&
        ["APPROVED", "EXECUTING", "SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN"].includes(state)
      )
        return {
          status: "already_approved" as const,
          state,
          version: p.currentVersion,
          approvedNow: false,
        };
      if (input.decision === "deny" && state === "DENIED")
        return {
          status: "already_denied" as const,
          state,
          version: p.currentVersion,
          approvedNow: false,
        };
      if (input.decision === "cancel" && state === "CANCELED")
        return {
          status: "already_canceled" as const,
          state,
          version: p.currentVersion,
          approvedNow: false,
        };
    }
    if (input.expectedVersion !== p.currentVersion)
      throw new DecisionError(
        "conflict",
        "This proposal was edited after you opened it. Review the latest version before deciding.",
        { currentVersion: p.currentVersion },
      );

    if (input.decision === "cancel") {
      if (state !== "PENDING_APPROVAL" && state !== "APPROVED")
        throw new DecisionError(
          "not_pending",
          state === "EXECUTING"
            ? "It is already executing and cannot be canceled."
            : "This proposal can no longer be canceled.",
        );
    } else if (state !== "PENDING_APPROVAL") {
      throw new DecisionError("not_pending", "This proposal is no longer waiting for a decision.", {
        state,
      });
    }

    if (input.decision === "approve") {
      // Nothing is approved unless the stored content still matches what was hashed at creation/edit.
      try {
        assertVersionIntegrity(p, version);
      } catch (e) {
        if (e instanceof IntegrityError) throw new DecisionError("integrity", e.message);
        throw e;
      }
      const policy = await evaluateForProposal(
        "decide",
        p,
        version.args as Record<string, unknown>,
        input.actorId,
      );
      if (!policy.allowed)
        throw new DecisionError(
          "policy_denied",
          "Workspace policy does not allow you to approve this.",
          { reasons: policy.reasons },
        );
    }

    const event = input.decision;
    await applyTransition(
      p.id,
      event,
      { actor: { type: "user", id: input.actorId }, detail: { version: p.currentVersion } },
      tx,
    );
    await tx.insert(approvalDecisions).values({
      proposalId: p.id,
      proposalVersionId: version.id,
      decision: input.decision,
      decidedByUserId: input.actorId,
      reason: input.reason?.slice(0, 500) ?? null,
    });
    await recordAudit(
      {
        workspaceId: p.workspaceId,
        actorType: "user",
        actorId: input.actorId,
        action: `proposal.${input.decision}d`
          .replace("denyd", "denied")
          .replace("canceld", "canceled")
          .replace("approved", "approved"),
        subjectType: "proposal",
        subjectId: p.id,
        correlationId: p.correlationId,
        detail: { version: p.currentVersion, bindingHash: version.bindingHash },
      },
      tx,
    );

    const to: ProposalState =
      input.decision === "approve" ? "APPROVED" : input.decision === "deny" ? "DENIED" : "CANCELED";
    return {
      status: (input.decision === "approve"
        ? "approved"
        : input.decision === "deny"
          ? "denied"
          : "canceled") as DecisionResult["status"],
      state: to,
      version: p.currentVersion,
      approvedNow: input.decision === "approve",
    };
  });

  if (result.approvedNow) await notifyApproved(input.proposalId, input.workspaceId);
  return { status: result.status, state: result.state, version: result.version };
}
