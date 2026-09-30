/** User-facing failure categories (product spec §16). Never expose raw status codes. */
export const ERROR_CATEGORIES = [
  "auth_expired",
  "scope_missing",
  "destination_inaccessible",
  "policy_changed",
  "proposal_expired",
  "provider_unavailable",
  "rate_limited",
  "provider_rejected",
  "failed_before_dispatch",
  "verification_required",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ERROR_GUIDANCE: Record<ErrorCategory, { title: string; recovery: string }> = {
  auth_expired: {
    title: "Connector authorization expired",
    recovery: "Reconnect the account on the Connections page, then propose the action again.",
  },
  scope_missing: {
    title: "Required provider permission is missing",
    recovery:
      "Reconnect and grant the requested permissions. The current grant does not allow this action.",
  },
  destination_inaccessible: {
    title: "Destination is no longer accessible",
    recovery:
      "Check that the connected account can still reach the repository, channel or sender, then try again.",
  },
  policy_changed: {
    title: "Workspace policy changed",
    recovery:
      "A policy no longer allows this action. Ask an owner to review Policies, or propose a different action.",
  },
  proposal_expired: {
    title: "Proposal expired",
    recovery: "Ask the AI to propose the action again. Nothing was sent or created.",
  },
  provider_unavailable: {
    title: "Provider unavailable",
    recovery:
      "The provider could not be reached. Nothing was confirmed as done; try again shortly.",
  },
  rate_limited: {
    title: "Rate limited by the provider",
    recovery:
      "The provider asked us to slow down. Wait and try again; the action was not performed.",
  },
  provider_rejected: {
    title: "Request rejected by the provider",
    recovery: "The provider refused the content or target. Edit the request and propose it again.",
  },
  failed_before_dispatch: {
    title: "Execution failed before dispatch",
    recovery: "The request never reached the provider. It is safe to propose the action again.",
  },
  verification_required: {
    title: "Provider may have accepted the action; verification required",
    recovery:
      "The provider did not confirm the result. Check the destination directly before retrying, to avoid a duplicate.",
  },
};

/** Thrown by provider code; carries a category and whether a write may have been accepted. */
export class ConnectorError extends Error {
  constructor(
    public category: ErrorCategory,
    message: string,
    /** True when the provider may have processed the write despite the error (timeouts, dropped connections). */
    public maybeDispatched = false,
  ) {
    super(message);
  }
}
