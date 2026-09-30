import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { getDb } from "@/db/client";
import { connectorAccounts, proposals } from "@/db/schema";
import { getCapability, providerOf } from "@/connectors/registry";
import { getEnv } from "@/lib/env";
import type { Capability } from "@/lib/permissions";
import { recordAudit } from "./audit";
import { evaluateForPropose } from "./policy";
import { applyTransition } from "./transitions";
import { getLatestArgs, insertVersion } from "./versions";

export type ProposalErrorCode =
  | "invalid_arguments"
  | "policy_denied"
  | "connector_required"
  | "connector_ambiguous"
  | "unknown_capability"
  | "content_too_large";

export class ProposalError extends Error {
  constructor(
    public code: ProposalErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type ProposalListener = (event: {
  proposalId: string;
  workspaceId: string;
  capability: Capability;
}) => void | Promise<void>;
const createdListeners = new Set<ProposalListener>();
/** Notifications and other side channels subscribe here; nothing in this file performs external actions. */
export function onProposalCreated(fn: ProposalListener) {
  createdListeners.add(fn);
  return () => createdListeners.delete(fn);
}

export const MAX_ARGS_BYTES = 400_000;

export type Principal = {
  grantId: string;
  userId: string;
  workspaceId: string;
  clientLabel: string;
};

export type CreatedProposal = {
  proposalId: string;
  state: string;
  version: number;
  summary: string;
  expiresAt: Date;
  reviewUrl: string;
  duplicate: boolean;
};

export const reviewUrl = (id: string) => `${getEnv().APP_URL.replace(/\/$/, "")}/inbox/${id}`;

async function pickConnector(workspaceId: string, capability: Capability, requested?: string) {
  const provider = providerOf(capability);
  const db = getDb();
  if (requested) {
    const [c] = await db
      .select()
      .from(connectorAccounts)
      .where(
        and(
          eq(connectorAccounts.id, requested),
          eq(connectorAccounts.workspaceId, workspaceId),
          eq(connectorAccounts.provider, provider),
        ),
      );
    // Same answer whether it does not exist or belongs to another workspace.
    if (!c)
      throw new ProposalError(
        "connector_required",
        "That connected account was not found for this workspace.",
      );
    return c;
  }
  const active = await db
    .select()
    .from(connectorAccounts)
    .where(
      and(
        eq(connectorAccounts.workspaceId, workspaceId),
        eq(connectorAccounts.provider, provider),
        eq(connectorAccounts.status, "active"),
      ),
    );
  if (active.length === 0)
    throw new ProposalError(
      "connector_required",
      `No active ${provider} account is connected to this workspace.`,
    );
  if (active.length > 1)
    throw new ProposalError(
      "connector_ambiguous",
      "More than one account is connected; specify which one.",
      { accounts: active.map((a) => ({ id: a.id, name: a.displayName })) },
    );
  return active[0]!;
}

/**
 * Creates a PENDING_APPROVAL proposal. Nothing is executed and no provider is contacted.
 * Retrying with the same clientRequestId returns the original proposal instead of a duplicate.
 */
export async function createProposal(input: {
  principal: Principal;
  capability: Capability;
  args: unknown;
  connectorAccountId?: string;
  clientRequestId?: string;
}): Promise<CreatedProposal> {
  const def = getCapability(input.capability);
  if (!def) throw new ProposalError("unknown_capability", "Unknown capability.");
  const db = getDb();
  const { principal } = input;

  if (input.clientRequestId) {
    const [dup] = await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, principal.workspaceId),
          eq(proposals.mcpGrantId, principal.grantId),
          eq(proposals.clientRequestId, input.clientRequestId),
        ),
      );
    if (dup) return toResult(dup, def.safeSummary((await getLatestArgs(dup.id)) as never), true);
  }

  let args: Record<string, unknown>;
  try {
    if (JSON.stringify(input.args ?? null).length > MAX_ARGS_BYTES)
      throw new ProposalError("content_too_large", "The proposal content is too large.");
    args = def.argsSchema.parse(input.args) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ProposalError) throw e;
    if (e instanceof ZodError)
      throw new ProposalError("invalid_arguments", "The proposal arguments are invalid.", {
        issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    throw e;
  }

  const connector = await pickConnector(
    principal.workspaceId,
    input.capability,
    input.connectorAccountId,
  );
  const policy = await evaluateForPropose({
    workspaceId: principal.workspaceId,
    capability: input.capability,
    connectorAccountId: connector.id,
    args,
    grantId: principal.grantId,
  });
  if (!policy.allowed)
    throw new ProposalError("policy_denied", "Workspace policy does not allow this proposal.", {
      reasons: policy.reasons,
    });

  const expiresAt = new Date(Date.now() + policy.expirySeconds * 1000);
  const correlationId = randomUUID();

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(proposals)
      .values({
        workspaceId: principal.workspaceId,
        capability: input.capability,
        connectorAccountId: connector.id,
        mcpGrantId: principal.grantId,
        clientLabel: principal.clientLabel,
        initiatedByUserId: principal.userId,
        state: "DRAFT",
        currentVersion: 1,
        correlationId,
        clientRequestId: input.clientRequestId ?? null,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return null; // lost an idempotency race
    const proposal = inserted[0]!;
    await insertVersion(tx, { proposal, version: 1, args, author: { type: "ai" } });
    await applyTransition(
      proposal.id,
      "submit",
      { actor: { type: "mcp_client", id: principal.grantId } },
      tx,
    );
    await recordAudit(
      {
        workspaceId: principal.workspaceId,
        actorType: "mcp_client",
        actorId: principal.grantId,
        action: "proposal.created",
        subjectType: "proposal",
        subjectId: proposal.id,
        correlationId,
        detail: {
          capability: input.capability,
          destination: def.destination(args as never),
          warnings: policy.warnings.map((w) => w.code),
        },
      },
      tx,
    );
    return proposal;
  });

  if (!created) {
    const [dup] = await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.workspaceId, principal.workspaceId),
          eq(proposals.mcpGrantId, principal.grantId),
          eq(proposals.clientRequestId, input.clientRequestId!),
        ),
      );
    return toResult(dup!, def.safeSummary(args as never), true);
  }
  // Listeners are best-effort: a failing one must never undo or fail a created proposal.
  for (const l of createdListeners) {
    try {
      await l({
        proposalId: created.id,
        workspaceId: created.workspaceId,
        capability: created.capability,
      });
    } catch {
      /* ignored */
    }
  }
  return toResult({ ...created, state: "PENDING_APPROVAL" }, def.safeSummary(args as never), false);
}

function toResult(
  p: typeof proposals.$inferSelect,
  summary: string,
  duplicate: boolean,
): CreatedProposal {
  return {
    proposalId: p.id,
    state: p.state,
    version: p.currentVersion,
    summary,
    expiresAt: p.expiresAt,
    reviewUrl: reviewUrl(p.id),
    duplicate,
  };
}

// ---------- Expiration ----------

/** Expires one proposal if it is past its deadline. Safe to call on every read/decision path. */
export async function expireIfDue(proposalId: string, now = new Date()): Promise<boolean> {
  const [p] = await getDb()
    .select({ state: proposals.state, expiresAt: proposals.expiresAt })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  if (
    !p ||
    p.expiresAt.getTime() > now.getTime() ||
    !["PENDING_APPROVAL", "APPROVED"].includes(p.state)
  )
    return false;
  try {
    await applyTransition(proposalId, "expire", {
      actor: { type: "system" },
      detail: { reason: "deadline_passed" },
    });
    return true;
  } catch {
    return false; // someone decided or expired it first
  }
}

/**
 * Persisted, multi-instance-safe sweep: due rows are claimed with FOR UPDATE SKIP LOCKED so two
 * instances never process the same proposal. Run from the internal cron endpoint.
 */
export async function sweepExpired(now = new Date(), batch = 200): Promise<number> {
  const db = getDb();
  const due = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`select id from proposals where state in ('PENDING_APPROVAL','APPROVED') and expires_at <= ${now} order by expires_at limit ${batch} for update skip locked`,
    );
    const ids = rows.rows.map((r) => r.id);
    for (const id of ids)
      await applyTransition(
        id,
        "expire",
        { actor: { type: "system" }, detail: { reason: "deadline_passed" } },
        tx,
      );
    return ids;
  });
  return due.length;
}

export async function countDue(now = new Date()) {
  const rows = await getDb()
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        inArray(proposals.state, ["PENDING_APPROVAL", "APPROVED"]),
        lte(proposals.expiresAt, now),
      ),
    );
  return rows.length;
}
