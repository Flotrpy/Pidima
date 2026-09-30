import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, notExists, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  connectorAccounts,
  executionAttempts,
  executions,
  proposalVersions,
  proposals,
  receipts,
  users,
  workspaces,
} from "@/db/schema";
import { diffArgs, type FieldDiff } from "@/approvals/diff";
import { argsHash } from "@/approvals/hashing";
import { ERROR_GUIDANCE, type ErrorCategory } from "@/connectors/errors";
import { getCapability } from "@/connectors/registry";
import type { ProposalState } from "@/components/ui/status";
import type { Executor } from "./audit";
import { requirePermission } from "./authz";
import { WorkspaceError } from "./workspaces";

/** States that settle a proposal for the user. Receipts are created for each. */
export const RECEIPT_STATES: ProposalState[] = [
  "DENIED",
  "CANCELED",
  "EXPIRED",
  "SUCCEEDED",
  "FAILED",
  "OUTCOME_UNKNOWN",
];

type Person = { id: string; name: string } | null;

export type ReceiptBody = {
  schema: 1;
  receiptNumber: string;
  kind: "original" | "correction";
  correctsReceiptNumber?: string;
  generatedAt: string;
  proposal: {
    id: string;
    version: number;
    capability: string;
    correlationId: string;
    createdAt: string;
    expiresAt: string;
  };
  workspace: { id: string; name: string };
  client: { label: string };
  /** Only set when the identity of the requester was verified by the MCP grant. */
  initiatedBy: Person;
  decision: {
    outcome: "approved" | "denied" | "canceled" | "expired" | "none";
    by: Person;
    at: string | null;
    reason: string | null;
  };
  hashes: { originalProposal: string; approvedContent: string; binding: string };
  humanEdits: {
    count: number;
    versions: { version: number; by: Person; at: string; reason: string | null }[];
    diff: FieldDiff[];
  };
  connector: { provider: string; displayName: string; externalAccountId: string } | null;
  action: { destination: string; summary: string; facts: { label: string; value: string }[] };
  execution: null | {
    state: string;
    startedAt: string;
    finishedAt: string | null;
    attempts: number;
    result: { providerId: string | null; url: string | null } | null;
    error:
      | { category: string; title: string; recovery: string }
      | { category: "verification_required"; title: string; recovery: string }
      | null;
  };
  finalState: ProposalState;
};

export const receiptNumber = (id: string) => `RCPT-${id.slice(0, 8).toUpperCase()}`;
const MAX_DIFF_BYTES = 50_000;

const person = (id: string | null, names: Map<string, string>): Person =>
  id ? { id, name: names.get(id) ?? "Unknown user" } : null;

/** Builds a receipt from the persisted record. Runs inside the settling transaction so it sees its writes. */
export async function buildReceiptBody(
  exec: Executor,
  proposalId: string,
  kind: "original" | "correction",
  id: string,
  correctsId?: string,
): Promise<ReceiptBody> {
  const [p] = await exec.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!p) throw new Error("Proposal not found");
  const def = getCapability(p.capability)!;
  const versions = await exec
    .select()
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, p.id))
    .orderBy(asc(proposalVersions.version));
  const first = versions[0]!;
  const final = versions.find((v) => v.version === p.currentVersion) ?? versions.at(-1)!;
  const decisions = await exec
    .select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.proposalId, p.id))
    .orderBy(asc(approvalDecisions.createdAt));
  const [ws] = await exec.select().from(workspaces).where(eq(workspaces.id, p.workspaceId));
  const [conn] = await exec
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, p.connectorAccountId));
  const [e] = await exec
    .select()
    .from(executions)
    .where(eq(executions.proposalId, p.id))
    .orderBy(desc(executions.startedAt))
    .limit(1);
  const attempts = e
    ? (
        await exec
          .select({ id: executionAttempts.id })
          .from(executionAttempts)
          .where(eq(executionAttempts.executionId, e.id))
      ).length
    : 0;

  const userIds = [
    ...new Set(
      [
        p.initiatedByUserId,
        ...decisions.map((d) => d.decidedByUserId),
        ...versions.map((v) => v.authorUserId),
      ].filter((x): x is string => !!x),
    ),
  ];
  const names = new Map(
    (userIds.length
      ? await exec
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
      : []
    ).map((u) => [u.id, u.name]),
  );

  const finalDecision = [...decisions].reverse().find((d) => d.decision !== "edit");
  const state = p.state as ProposalState;
  const outcome: ReceiptBody["decision"]["outcome"] =
    state === "EXPIRED"
      ? "expired"
      : finalDecision
        ? finalDecision.decision === "approve"
          ? "approved"
          : finalDecision.decision === "deny"
            ? "denied"
            : "canceled"
        : "none";

  let diff = diffArgs(first.args as Record<string, unknown>, final.args as Record<string, unknown>);
  if (JSON.stringify(diff).length > MAX_DIFF_BYTES)
    diff = diff.map((d) => ({
      key: d.key,
      kind: "scalar" as const,
      before: "(too large to include)",
      after: "(too large to include)",
    }));
  const edits = decisions.filter((d) => d.decision === "edit");
  const editVersions = versions.filter((v) => v.authorType === "human");

  const errCat = e?.errorCategory as ErrorCategory | null | undefined;
  const result = e?.providerResult as
    { providerId?: string; url?: string | null } | null | undefined;

  return {
    schema: 1,
    receiptNumber: receiptNumber(id),
    kind,
    ...(correctsId ? { correctsReceiptNumber: receiptNumber(correctsId) } : {}),
    generatedAt: new Date().toISOString(),
    proposal: {
      id: p.id,
      version: final.version,
      capability: p.capability,
      correlationId: p.correlationId,
      createdAt: p.createdAt.toISOString(),
      expiresAt: p.expiresAt.toISOString(),
    },
    workspace: { id: p.workspaceId, name: ws?.name ?? "" },
    client: { label: p.clientLabel },
    initiatedBy: person(p.initiatedByUserId, names),
    decision: {
      outcome,
      by: person(finalDecision?.decidedByUserId ?? null, names),
      at: finalDecision?.createdAt.toISOString() ?? null,
      reason: finalDecision?.reason ?? null,
    },
    hashes: {
      originalProposal: first.argsHash,
      approvedContent: final.argsHash,
      binding: final.bindingHash,
    },
    humanEdits: {
      count: edits.length,
      versions: editVersions.map((v) => ({
        version: v.version,
        by: person(v.authorUserId, names),
        at: v.createdAt.toISOString(),
        reason: edits.find((d) => d.proposalVersionId === v.id)?.reason ?? null,
      })),
      diff,
    },
    connector: conn
      ? {
          provider: conn.provider,
          displayName: conn.displayName,
          externalAccountId: conn.externalAccountId,
        }
      : null,
    action: {
      destination: final.destination,
      summary: def.safeSummary(final.args as never),
      facts: def.receiptFacts(final.args as never),
    },
    execution: e
      ? {
          state: e.state,
          startedAt: e.startedAt.toISOString(),
          finishedAt: e.finishedAt?.toISOString() ?? null,
          attempts,
          result:
            e.state === "SUCCEEDED"
              ? { providerId: result?.providerId ?? null, url: result?.url ?? null }
              : null,
          error:
            errCat && errCat in ERROR_GUIDANCE
              ? {
                  category: errCat,
                  title: ERROR_GUIDANCE[errCat].title,
                  recovery: ERROR_GUIDANCE[errCat].recovery,
                }
              : null,
        }
      : null,
    finalState: state,
  };
}

/**
 * Writes the receipt for a settled state. The first settling state produces the original; a later
 * resolution of an unknown outcome produces a linked CORRECTION (nothing is ever rewritten).
 * Idempotent: a repeat call for the same state is a no-op.
 */
export async function writeReceiptForState(
  exec: Executor,
  proposalId: string,
  to: ProposalState,
  from: ProposalState,
) {
  if (!RECEIPT_STATES.includes(to)) return;
  const [p] = await exec
    .select({ workspaceId: proposals.workspaceId, currentVersion: proposals.currentVersion })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  if (!p) return;
  const [ver] = await exec
    .select({ id: proposalVersions.id })
    .from(proposalVersions)
    .where(
      and(
        eq(proposalVersions.proposalId, proposalId),
        eq(proposalVersions.version, p.currentVersion),
      ),
    );
  const existing = await exec
    .select()
    .from(receipts)
    .where(eq(receipts.proposalId, proposalId))
    .orderBy(asc(receipts.createdAt));
  const original = existing.find((r) => r.kind === "original");

  const isCorrection = !!original && from === "OUTCOME_UNKNOWN";
  if (original && !isCorrection) return; // already settled once
  if (
    existing.some(
      (r) => r.finalState === to && r.kind === (isCorrection ? "correction" : "original"),
    )
  )
    return;

  const id = randomUUID();
  const body = await buildReceiptBody(
    exec,
    proposalId,
    isCorrection ? "correction" : "original",
    id,
    isCorrection ? original!.id : undefined,
  );
  await exec
    .insert(receipts)
    .values({
      id,
      workspaceId: p.workspaceId,
      proposalId,
      proposalVersionId: ver!.id,
      kind: isCorrection ? "correction" : "original",
      correctsReceiptId: isCorrection ? original!.id : null,
      finalState: to,
      body: body as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing();
}

/** Safety net: creates receipts for any settled proposal that lacks one (e.g. pre-existing rows). */
export async function backfillMissingReceipts(limit = 100): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: proposals.id, state: proposals.state })
    .from(proposals)
    .where(
      and(
        inArray(proposals.state, RECEIPT_STATES as never),
        notExists(
          db
            .select({ x: receipts.id })
            .from(receipts)
            .where(and(eq(receipts.proposalId, proposals.id), eq(receipts.kind, "original"))),
        ),
      ),
    )
    .limit(limit);
  for (const r of rows)
    await db.transaction((tx) =>
      writeReceiptForState(tx, r.id, r.state as ProposalState, "PENDING_APPROVAL"),
    );
  return rows.length;
}

export type ReceiptRow = typeof receipts.$inferSelect;

/** Receipts for one proposal, oldest first (original, then any corrections). */
export async function getReceiptsForProposal(
  actorId: string,
  workspaceId: string,
  proposalId: string,
): Promise<{ id: string; kind: string; createdAt: Date; body: ReceiptBody }[]> {
  await requirePermission(actorId, workspaceId, "receipts.view");
  const rows = await getDb()
    .select()
    .from(receipts)
    .where(and(eq(receipts.proposalId, proposalId), eq(receipts.workspaceId, workspaceId)))
    .orderBy(asc(receipts.createdAt));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.createdAt,
    body: r.body as unknown as ReceiptBody,
  }));
}

export async function getReceipt(actorId: string, workspaceId: string, receiptId: string) {
  await requirePermission(actorId, workspaceId, "receipts.view");
  if (!/^[0-9a-f-]{36}$/i.test(receiptId))
    throw new WorkspaceError("not_found", "Receipt not found");
  const [r] = await getDb()
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.workspaceId, workspaceId)));
  if (!r) throw new WorkspaceError("not_found", "Receipt not found");
  return { id: r.id, kind: r.kind, createdAt: r.createdAt, body: r.body as unknown as ReceiptBody };
}
