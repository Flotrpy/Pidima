import "server-only";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { approvalDecisions, proposals } from "@/db/schema";
import { argsHash } from "@/approvals/hashing";
import { getCapability } from "@/connectors/registry";
import { canDecide } from "@/lib/permissions";
import { recordAudit } from "./audit";
import { loadMembership } from "./authz";
import { evaluateForProposal } from "./policy";
import { MAX_ARGS_BYTES, expireIfDue } from "./proposals";
import { applyTransition } from "./transitions";
import { connectorAccounts } from "@/db/schema";
import { resolveWithProvider, validateWithProvider } from "./proposal-validation";
import { getVersion, insertVersion } from "./versions";

export class EditError extends Error {
  constructor(
    public code:
      | "invalid_arguments"
      | "policy_denied"
      | "conflict"
      | "not_editable"
      | "no_changes"
      | "forbidden"
      | "not_found",
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * A human edit appends a NEW immutable version and leaves the proposal pending on it. The AI's
 * version is preserved untouched, so the receipt can show exactly what a person changed.
 */
export async function editProposal(input: {
  actorId: string;
  workspaceId: string;
  proposalId: string;
  expectedVersion: number;
  args: unknown;
  reason?: string;
}) {
  const db = getDb();
  const m = await loadMembership(input.actorId, input.workspaceId);
  if (!m) throw new EditError("not_found", "Proposal not found");
  await expireIfDue(input.proposalId);

  const [p0] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, input.proposalId), eq(proposals.workspaceId, input.workspaceId)));
  if (!p0) throw new EditError("not_found", "Proposal not found");
  const def = getCapability(p0.capability)!;
  // Editing changes what will be executed, so it needs the same authority as approving it.
  if (!canDecide(m.role, m.approvalCapabilities, p0.capability))
    throw new EditError("forbidden", "You are not allowed to edit this type of action.");

  let args: Record<string, unknown>;
  try {
    if (JSON.stringify(input.args ?? null).length > MAX_ARGS_BYTES)
      throw new EditError("invalid_arguments", "The content is too large.");
    args = def.argsSchema.parse(input.args) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof EditError) throw e;
    if (e instanceof ZodError)
      throw new EditError("invalid_arguments", "Some fields are invalid.", {
        issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    throw e;
  }

  // Resolve friendly references (e.g. "#ops") to canonical IDs BEFORE policy sees the destination.
  const [connector] = await db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, p0.connectorAccountId));
  if (connector) {
    const resolved = await resolveWithProvider(connector, p0.capability, args);
    if (!resolved.ok)
      throw new EditError("policy_denied", resolved.message, {
        reasons: [{ code: "destination_invalid", message: resolved.message }],
      });
    args = resolved.args;
  }

  // The new content (including a changed destination) must satisfy today's policy.
  // Separation of duties governs approving, not editing, so that one rule is set aside here.
  const policy = await evaluateForProposal("decide", p0, args, input.actorId);
  const blockers = policy.reasons.filter(
    (r) => r.code !== "self_approval" && r.code !== "not_an_approver",
  );
  if (blockers.length > 0)
    throw new EditError("policy_denied", "Workspace policy does not allow this change.", {
      reasons: blockers,
    });

  let display: Record<string, string> = {};
  if (connector) {
    const v = await validateWithProvider(connector, p0.capability, args);
    if (v.status === "rejected")
      throw new EditError("policy_denied", v.message, {
        reasons: [{ code: "destination_invalid", message: v.message }],
      });
    if (v.status === "ok") display = v.display ?? {};
  }

  return db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, input.proposalId))
      .for("update");
    if (!p || p.state !== "PENDING_APPROVAL")
      throw new EditError("not_editable", "This proposal can no longer be edited.");
    if (p.currentVersion !== input.expectedVersion)
      throw new EditError(
        "conflict",
        "Someone else changed this proposal. Reload to see the latest version.",
      );

    const current = await getVersion(tx, p.id, p.currentVersion);
    if (current && argsHash(current.args as Record<string, unknown>) === argsHash(args))
      throw new EditError("no_changes", "Nothing was changed.");

    const next = p.currentVersion + 1;
    const version = await insertVersion(tx, {
      proposal: p,
      version: next,
      args,
      display,
      author: { type: "human", userId: input.actorId },
    });
    await applyTransition(
      p.id,
      "edit",
      {
        actor: { type: "user", id: input.actorId },
        extra: { currentVersion: next },
        detail: { fromVersion: p.currentVersion, toVersion: next },
      },
      tx,
    );
    await tx.insert(approvalDecisions).values({
      proposalId: p.id,
      proposalVersionId: version.id,
      decision: "edit",
      decidedByUserId: input.actorId,
      reason: input.reason?.slice(0, 500) ?? null,
    });
    await recordAudit(
      {
        workspaceId: p.workspaceId,
        actorType: "user",
        actorId: input.actorId,
        action: "proposal.edited",
        subjectType: "proposal",
        subjectId: p.id,
        correlationId: p.correlationId,
        detail: {
          version: next,
          destinationChanged: current ? current.destination !== version.destination : false,
        },
      },
      tx,
    );
    return { version: next, destination: version.destination };
  });
}
