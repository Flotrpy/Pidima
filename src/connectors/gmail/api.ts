import { ConnectorError, type ErrorCategory } from "../errors";

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";
export const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

export const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Least privilege: send only (cannot read mail), plus identity so we know which address sends. */
export const GOOGLE_SCOPES = ["openid", "email", SEND_SCOPE] as const;

export const gmailHeaders = (token: string, json = false) => ({
  authorization: `Bearer ${token}`,
  "user-agent": "ai-action-inbox",
  ...(json ? { "content-type": "application/json" } : {}),
});

/** Maps Google's error envelope/status to categories. Unknown = provider rejection, never success. */
export function googleError(
  status: number,
  body: {
    error?: { status?: string; message?: string; errors?: { reason?: string }[] } | string;
    error_description?: string;
  } | null,
  write: boolean,
): { category: ErrorCategory; message: string; maybeDispatched: boolean } {
  const err =
    typeof body?.error === "string"
      ? body.error
      : (body?.error as { status?: string } | undefined)?.status;
  const reason = typeof body?.error === "object" ? body.error?.errors?.[0]?.reason : undefined;
  if (err === "invalid_grant" || status === 401 || err === "UNAUTHENTICATED")
    return {
      category: "auth_expired",
      message: "Google no longer accepts this connection.",
      maybeDispatched: false,
    };
  if (
    status === 403 &&
    (reason === "rateLimitExceeded" ||
      reason === "userRateLimitExceeded" ||
      reason === "dailyLimitExceeded")
  )
    return {
      category: "rate_limited",
      message: "Google is rate limiting this connection.",
      maybeDispatched: false,
    };
  if (status === 403 || err === "PERMISSION_DENIED")
    return {
      category: "scope_missing",
      message: "The Google connection lacks permission to send mail.",
      maybeDispatched: false,
    };
  if (status === 429)
    return {
      category: "rate_limited",
      message: "Google is rate limiting this connection.",
      maybeDispatched: false,
    };
  if (status === 404)
    return {
      category: "destination_inaccessible",
      message: "Google could not find the requested resource.",
      maybeDispatched: false,
    };
  if (status >= 500 || status === 408)
    return write
      ? {
          category: "verification_required",
          message: "Google did not confirm whether the message was accepted.",
          maybeDispatched: true,
        }
      : {
          category: "provider_unavailable",
          message: "Google is temporarily unavailable.",
          maybeDispatched: false,
        };
  return {
    category: "provider_rejected",
    message: "Google rejected the request.",
    maybeDispatched: false,
  };
}

export function throwGoogle(
  status: number,
  body: Parameters<typeof googleError>[1],
  write = false,
): never {
  const e = googleError(status, body, write);
  throw new ConnectorError(e.category, e.message, e.maybeDispatched);
}
