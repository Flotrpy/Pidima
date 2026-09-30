export type ProposalState =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "OUTCOME_UNKNOWN"
  | "SUPERSEDED"
  | "DENIED"
  | "CANCELED"
  | "EXPIRED";

export type StatusTone = "pending" | "success" | "failure" | "unknown" | "neutral";

export const STATUS_META: Record<ProposalState, { label: string; tone: StatusTone; icon: string }> =
  {
    DRAFT: { label: "Draft", tone: "neutral", icon: "✎" },
    PENDING_APPROVAL: { label: "Needs review", tone: "pending", icon: "◔" },
    APPROVED: { label: "Approved", tone: "pending", icon: "✓" },
    EXECUTING: { label: "Executing", tone: "pending", icon: "↻" },
    SUCCEEDED: { label: "Completed", tone: "success", icon: "✓" },
    FAILED: { label: "Failed", tone: "failure", icon: "✕" },
    OUTCOME_UNKNOWN: { label: "Outcome unknown", tone: "unknown", icon: "?" },
    SUPERSEDED: { label: "Superseded by edit", tone: "neutral", icon: "⇢" },
    DENIED: { label: "Denied", tone: "failure", icon: "⊘" },
    CANCELED: { label: "Canceled", tone: "neutral", icon: "—" },
    EXPIRED: { label: "Expired", tone: "neutral", icon: "⌛" },
  };
