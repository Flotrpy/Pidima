import { getEnv } from "@/lib/env";
import { ConnectorError } from "../errors";
import { safeFetchFor } from "../transport";
import type {
  ConnectorRuntime,
  ExecutionOutcome,
  HealthStepResult,
  HealthTestResult,
  ProposalValidation,
  RuntimeContext,
} from "../types";
import { GMAIL_API, SEND_SCOPE, gmailHeaders, googleError } from "./api";
import { buildMime, messageIdFor } from "./mime";
import { fetchGrantedScopes, fetchIdentity, refreshAccessToken } from "./oauth";

const step = (
  id: HealthStepResult["id"],
  label: string,
  status: HealthStepResult["status"],
  detail?: string,
): HealthStepResult => ({ id, label, status, detail });
const skipped = (...a: [HealthStepResult["id"], string][]) =>
  a.map(([i, l]) => step(i, l, "skipped"));
const REST: [HealthStepResult["id"], string][] = [
  ["identity", "Connected identity"],
  ["scopes", "Granted permissions"],
  ["destinations", "Sender identity"],
];

/** Read-only checks. Never sends mail (and cannot read it: the grant is send-only). */
export async function gmailHealthTest(ctx: RuntimeContext): Promise<HealthTestResult> {
  let token: string;
  try {
    token = await ctx.getAccessToken();
  } catch (e) {
    const auth = e instanceof ConnectorError && e.category === "auth_expired";
    return {
      overall: "fail",
      authFailed: auth,
      steps: [
        step(
          "credential",
          "Credential validity",
          "fail",
          auth
            ? "The Google connection has expired or was revoked. Reconnect it."
            : "The stored credential could not be read.",
        ),
        step("reachability", "API reachability", "skipped"),
        ...skipped(...REST),
      ],
    };
  }
  let reachable = true;
  try {
    const r = await ctx.fetch("https://www.googleapis.com/oauth2/v3/certs", {
      headers: { "user-agent": "ai-action-inbox" },
    });
    reachable = r.ok;
  } catch {
    reachable = false;
  }
  const reach = reachable
    ? step("reachability", "API reachability", "pass", "Google responded.")
    : step("reachability", "API reachability", "fail", "Google could not be reached.");
  if (!reachable)
    return {
      overall: "fail",
      steps: [
        step(
          "credential",
          "Credential validity",
          "skipped",
          "Not checked because Google was unreachable.",
        ),
        reach,
        ...skipped(...REST),
      ],
    };

  let who;
  try {
    who = await fetchIdentity(ctx.fetch, token);
  } catch (e) {
    const auth = e instanceof ConnectorError && e.category === "auth_expired";
    const detail = auth
      ? "Google no longer accepts this connection. Reconnect it."
      : e instanceof ConnectorError && e.category === "rate_limited"
        ? "Google is rate limiting this connection. Try again later."
        : "Google could not validate the credential right now.";
    return {
      overall: "fail",
      authFailed: auth,
      steps: [
        step("credential", "Credential validity", "fail", detail),
        reach,
        ...skipped(...REST),
      ],
    };
  }
  const credential = step(
    "credential",
    "Credential validity",
    "pass",
    "Google accepted the credential.",
  );
  const expected = String(ctx.account.metadata.email ?? "");
  const same = who.sub === ctx.account.externalAccountId && (!expected || who.email === expected);
  const identity = same
    ? step("identity", "Connected identity", "pass", `Signed in as ${who.email}.`)
    : step(
        "identity",
        "Connected identity",
        "fail",
        `This token belongs to ${who.email}, not the account that was connected. Reconnect.`,
      );

  let scopes: HealthStepResult;
  let granted: string[] = [];
  try {
    granted = await fetchGrantedScopes(ctx.fetch, token);
    scopes = granted.includes(SEND_SCOPE)
      ? step(
          "scopes",
          "Granted permissions",
          "pass",
          "Google reports permission to send email (and nothing that reads it).",
        )
      : step(
          "scopes",
          "Granted permissions",
          "fail",
          "Permission to send email is missing. Reconnect and accept it.",
        );
  } catch {
    scopes = step(
      "scopes",
      "Granted permissions",
      "fail",
      "Permissions could not be checked right now.",
    );
  }

  const senders = Array.isArray(ctx.account.metadata.senderAddresses)
    ? (ctx.account.metadata.senderAddresses as string[])
    : [];
  const sender = senders.length
    ? step(
        "destinations",
        "Sender identity",
        "pass",
        `Emails can be sent from ${senders.join(", ")}. No test email is sent.`,
      )
    : step("destinations", "Sender identity", "fail", "No sender address is recorded. Reconnect.");

  const all = [credential, reach, identity, scopes, sender];
  const failed = all.filter((s) => s.status === "fail").length;
  return {
    overall: failed === 0 ? "pass" : same && granted.includes(SEND_SCOPE) ? "partial" : "fail",
    identity: same ? { displayName: who.email, externalAccountId: who.sub } : undefined,
    grantedScopes: granted.length ? granted : undefined,
    steps: all,
  };
}

/** Local, read-only sender check: the From address must be an identity this connection may send as. */
export function gmailValidateProposal(
  ctx: RuntimeContext,
  args: Record<string, unknown>,
): ProposalValidation {
  const senders = (
    Array.isArray(ctx.account.metadata.senderAddresses)
      ? (ctx.account.metadata.senderAddresses as string[])
      : []
  ).map((s) => s.toLowerCase());
  const from = String(args.from ?? "").toLowerCase();
  if (!senders.includes(from)) {
    return {
      status: "rejected",
      category: "policy_changed",
      message: `${args.from} is not a sender this connection can use. Available: ${senders.join(", ") || "none"}.`,
    };
  }
  return { status: "ok", display: { from: ctx.account.displayName } };
}

type MailArgs = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
};

/** The single email write. "Accepted by Gmail" is all it can claim: never delivery, never read. */
export async function gmailSend(
  ctx: RuntimeContext,
  args: Record<string, unknown>,
  opts: { idempotencyKey: string },
): Promise<ExecutionOutcome> {
  const a = args as unknown as MailArgs;
  let token: string;
  try {
    token = await ctx.getAccessToken();
  } catch (e) {
    return {
      status: "failed",
      category: e instanceof ConnectorError ? e.category : "auth_expired",
      message: "The Google connection needs to be reconnected.",
    };
  }
  let raw: string;
  try {
    raw = Buffer.from(
      buildMime({
        ...a,
        cc: a.cc ?? [],
        bcc: a.bcc ?? [],
        messageId: messageIdFor(opts.idempotencyKey, a.from),
      }),
      "utf8",
    ).toString("base64url");
  } catch {
    return {
      status: "failed",
      category: "failed_before_dispatch",
      message: "The message could not be built safely. Nothing was sent.",
    };
  }
  try {
    const res = await ctx.fetch(`${GMAIL_API}/users/me/messages/send`, {
      method: "POST",
      headers: gmailHeaders(token, true),
      body: JSON.stringify({ raw }),
    });
    const j = (await res.json().catch(() => null)) as {
      id?: string;
      threadId?: string;
      error?: unknown;
    } | null;
    if (!res.ok) {
      const e = googleError(res.status, j as never, true);
      return e.maybeDispatched
        ? { status: "unknown", reason: e.message }
        : { status: "failed", category: e.category, message: e.message };
    }
    if (typeof j?.id !== "string")
      return {
        status: "unknown",
        reason: "Google accepted the request but returned an unexpected response.",
      };
    const all = new Set([...a.to, ...(a.cc ?? []), ...(a.bcc ?? [])]);
    return {
      status: "succeeded",
      providerId: j.id,
      details: {
        messageId: j.id,
        threadId: j.threadId ?? null,
        recipientCount: all.size,
        acceptedByProvider: true,
      },
    };
  } catch (e) {
    if (e instanceof ConnectorError)
      return e.maybeDispatched
        ? { status: "unknown", reason: e.message }
        : { status: "failed", category: e.category, message: e.message };
    return { status: "unknown", reason: "Unexpected error after the request was sent" };
  }
}

export const gmailRuntime: ConnectorRuntime = {
  provider: "gmail",
  healthTest: gmailHealthTest,
  validateProposal: async (ctx, _c, args) => gmailValidateProposal(ctx, args),
  execute: (ctx, _capability, args, opts) => gmailSend(ctx, args, opts),
  // No `reconcile`: finding a sent message needs read scopes we deliberately do not request.
  // An ambiguous send stays OUTCOME_UNKNOWN until a person checks the Sent folder.
  async refresh(current) {
    const e = getEnv();
    if (!e.CONNECTOR_GOOGLE_CLIENT_ID || !e.CONNECTOR_GOOGLE_CLIENT_SECRET || !current.refreshToken)
      throw new ConnectorError("auth_expired", "Cannot refresh the Google token");
    const r = await refreshAccessToken(safeFetchFor("gmail"), {
      clientId: e.CONNECTOR_GOOGLE_CLIENT_ID,
      clientSecret: e.CONNECTOR_GOOGLE_CLIENT_SECRET,
      refreshToken: current.refreshToken,
    });
    return {
      credentials: {
        ...current,
        accessToken: r.accessToken,
        refreshToken: r.refreshToken ?? current.refreshToken,
      },
      expiresAt: r.expiresIn ? new Date(Date.now() + r.expiresIn * 1000) : null,
    };
  },
};
