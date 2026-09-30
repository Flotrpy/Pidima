import { ConnectorError, type ErrorCategory } from "../errors";

export const SLACK_API = "https://slack.com/api";
export const SLACK_WEB = "https://slack.com";

/** Least privilege: post where the app is a member, list what it can see. No `chat:write.public`. */
export const SLACK_SCOPES = ["chat:write", "channels:read", "groups:read"] as const;

export type SlackSenderMode = "bot" | "user";
export const isSenderMode = (v: unknown): v is SlackSenderMode => v === "bot" || v === "user";

export const SENDER_LABEL: Record<SlackSenderMode, string> = {
  bot: "Messages appear from the app (bot), not from a person.",
  user: "Messages appear as YOU, from your own Slack account.",
};

export const slackHeaders = (token: string, json = false) => ({
  authorization: `Bearer ${token}`,
  "user-agent": "ai-action-inbox",
  ...(json ? { "content-type": "application/json; charset=utf-8" } : {}),
});

export const parseScopeHeader = (v: string | null): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Slack reports most failures as HTTP 200 with {ok:false, error}. Translates the error codes we can
 * meet into categories. Unknown codes are treated as a provider rejection, never as success.
 */
export function slackErrorCategory(code: string | undefined): {
  category: ErrorCategory;
  message: string;
} {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
    case "invalid_code":
    case "bad_client_secret":
      return { category: "auth_expired", message: "Slack no longer accepts this connection." };
    case "missing_scope":
    case "no_permission":
    case "not_allowed_token_type":
    case "restricted_action":
      return {
        category: "scope_missing",
        message: "The Slack connection lacks a required permission.",
      };
    case "channel_not_found":
    case "not_in_channel":
    case "is_archived":
    case "thread_not_found":
    case "message_not_found":
      return {
        category: "destination_inaccessible",
        message: "The Slack channel or thread is not accessible to this connection.",
      };
    case "ratelimited":
    case "rate_limited":
      return { category: "rate_limited", message: "Slack is rate limiting this connection." };
    case "service_unavailable":
    case "internal_error":
    case "fatal_error":
    case "request_timeout":
      return { category: "provider_unavailable", message: "Slack is temporarily unavailable." };
    default:
      return { category: "provider_rejected", message: "Slack rejected the request." };
  }
}

export function throwSlack(code: string | undefined, maybeDispatched = false): never {
  const c = slackErrorCategory(code);
  // 5xx-style Slack errors on a write are ambiguous: the message may already have been posted.
  const ambiguous = maybeDispatched && c.category === "provider_unavailable";
  throw new ConnectorError(ambiguous ? "verification_required" : c.category, c.message, ambiguous);
}
