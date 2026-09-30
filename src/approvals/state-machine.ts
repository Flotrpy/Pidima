import type { ProposalState } from "@/components/ui/status";

export type ProposalEvent =
  | "submit"
  | "approve"
  | "edit"
  | "deny"
  | "cancel"
  | "expire"
  | "claim"
  | "succeed"
  | "fail"
  | "mark_unknown"
  | "reconcile_success"
  | "reconcile_failure";

/**
 * The complete, server-enforced transition table. Anything not listed is illegal.
 *
 *   DRAFT ─submit→ PENDING_APPROVAL ─approve→ APPROVED ─claim→ EXECUTING ─succeed→ SUCCEEDED
 *                       │ edit→ SUPERSEDED         │ fail (pre-dispatch check failed) → FAILED
 *                       │ deny→ DENIED             │ cancel/expire
 *                       │ cancel→ CANCELED         └─ EXECUTING ─fail→ FAILED
 *                       └ expire→ EXPIRED                       └mark_unknown→ OUTCOME_UNKNOWN ─reconcile→ SUCCEEDED | FAILED
 */
const TABLE: Record<ProposalState, Partial<Record<ProposalEvent, ProposalState>>> = {
  DRAFT: { submit: "PENDING_APPROVAL", cancel: "CANCELED" },
  PENDING_APPROVAL: {
    approve: "APPROVED",
    edit: "SUPERSEDED",
    deny: "DENIED",
    cancel: "CANCELED",
    expire: "EXPIRED",
  },
  APPROVED: { claim: "EXECUTING", cancel: "CANCELED", expire: "EXPIRED", fail: "FAILED" },
  EXECUTING: { succeed: "SUCCEEDED", fail: "FAILED", mark_unknown: "OUTCOME_UNKNOWN" },
  OUTCOME_UNKNOWN: { reconcile_success: "SUCCEEDED", reconcile_failure: "FAILED" },
  SUCCEEDED: {},
  FAILED: {},
  SUPERSEDED: {},
  DENIED: {},
  CANCELED: {},
  EXPIRED: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    public from: ProposalState,
    public event: ProposalEvent,
  ) {
    super(`Cannot ${event} a proposal that is ${from}`);
  }
}

export function nextState(from: ProposalState, event: ProposalEvent): ProposalState {
  const to = TABLE[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export const canTransition = (from: ProposalState, event: ProposalEvent) =>
  TABLE[from][event] !== undefined;

/** Terminal for the user's purposes: only a brand-new proposal can follow. OUTCOME_UNKNOWN is not terminal until reconciled. */
export const isTerminal = (s: ProposalState) => Object.keys(TABLE[s]).length === 0;

export const ALL_STATES = Object.keys(TABLE) as ProposalState[];
export const ALL_EVENTS: ProposalEvent[] = [
  "submit",
  "approve",
  "edit",
  "deny",
  "cancel",
  "expire",
  "claim",
  "succeed",
  "fail",
  "mark_unknown",
  "reconcile_success",
  "reconcile_failure",
];

/** Allowed (from, to) pairs, used to generate the database guard. */
export function allowedPairs(): [ProposalState, ProposalState][] {
  const out = new Set<string>();
  for (const from of ALL_STATES)
    for (const to of Object.values(TABLE[from])) out.add(`${from}>${to}`);
  return [...out].map((p) => p.split(">") as [ProposalState, ProposalState]);
}
