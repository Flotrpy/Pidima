import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, notExists, or, sql } from "drizzle-orm";
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
    result: {
      providerId: string | null;
      url: string | null;
      /** What the provider result does and does not prove. */
      note: string | null;
      /** Whitelisted, non-sensitive provider facts (issue number, channel, message timestamp, how it was sent). */
      details: Record<string, string | number | boolean | null>;
    } | null;
    error:
      | { category: string; title: string; recovery: string }
      | { category: "verification_required"; title: string; recovery: string }
      | null;
  };
  finalState: ProposalState;
};

export const receiptNumber = (id: string) => `RCPT-${id.slice(0, 8).toUpperCase()}`;
const MAX_DIFF_BYTES = 50_000;

export const RESULT_NOTES: Record<string, string> = {
  "email.propose_message":
    "Accepted by the email provider for sending. This does not confirm delivery to an inbox or that anyone read it.",
};
/** Provider result fields that may appear on a receipt. Anything else (tokens, bodies) is dropped. */
const RESULT_DETAIL_KEYS = [
  "issueNumber",
  "repository",
  "channel",
  "messageTs",
  "threadTs",
  "sentAs",
  "reconciled",
  "messageId",
  "threadId",
  "recipientCount",
  "acceptedByProvider",
] as const;

function safeDetails(
  result: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of RESULT_DETAIL_KEYS) {
    const v = result?.[k];
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

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
  const display = (final.display ?? {}) as Record<string, string>;
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
      facts: def.receiptFacts(final.args as never, display),
    },
    execution: e
      ? {
          state: e.state,
          startedAt: e.startedAt.toISOString(),
          finishedAt: e.finishedAt?.toISOString() ?? null,
          attempts,
          result:
            e.state === "SUCCEEDED"
              ? {
                  providerId: result?.providerId ?? null,
                  url: result?.url ?? null,
                  note: RESULT_NOTES[p.capability] ?? null,
                  details: safeDetails(result as Record<string, unknown> | null),
                }
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

export const HISTORY_FILTERS = {
  all: { label: "All", states: RECEIPT_STATES },
  completed: { label: "Completed", states: ["SUCCEEDED"] as ProposalState[] },
  failed: { label: "Failed", states: ["FAILED"] as ProposalState[] },
  unknown: { label: "Outcome unknown", states: ["OUTCOME_UNKNOWN"] as ProposalState[] },
  denied: { label: "Denied or canceled", states: ["DENIED", "CANCELED"] as ProposalState[] },
  expired: { label: "Expired", states: ["EXPIRED"] as ProposalState[] },
} as const;
export type HistoryFilter = keyof typeof HISTORY_FILTERS;
export const isHistoryFilter = (v: unknown): v is HistoryFilter =>
  typeof v === "string" && Object.hasOwn(HISTORY_FILTERS, v);
export const HISTORY_PAGE = 25;

export type HistoryRow = {
  receiptId: string;
  proposalId: string;
  kind: string;
  finalState: ProposalState;
  createdAt: Date;
  summary: string;
  destination: string;
  client: string;
  decidedBy: string | null;
  recovery: { title: string; recovery: string } | null;
};

/**
 * Settled items, newest first. Receipts are the record, so a correction supersedes its original:
 * only the latest receipt per proposal is listed. Keyset-paginated; workspace-scoped.
 */
export async function listHistory(
  actorId: string,
  workspaceId: string,
  filter: HistoryFilter = "all",
  cursor?: string,
) {
  await requirePermission(actorId, workspaceId, "receipts.view");
  let c: { t: Date; id: string } | null = null;
  try {
    const j = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) : null;
    if (
      j &&
      typeof j.t === "string" &&
      typeof j.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(j.id) &&
      !Number.isNaN(Date.parse(j.t))
    )
      c = { t: new Date(j.t), id: j.id };
  } catch {
    c = null;
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.workspaceId, workspaceId),
        inArray(receipts.finalState, [...HISTORY_FILTERS[filter].states] as never),
        // Hide originals that have a later correction.
        notExists(
          db
            .select({ x: sql`1` })
            .from(sql`receipts r2`)
            .where(
              sql`r2.proposal_id = ${receipts.proposalId} AND r2.created_at > ${receipts.createdAt}`,
            ),
        ),
        c
          ? or(lt(receipts.createdAt, c.t), and(eq(receipts.createdAt, c.t), lt(receipts.id, c.id)))
          : undefined,
      ),
    )
    .orderBy(desc(receipts.createdAt), desc(receipts.id))
    .limit(HISTORY_PAGE + 1);
  const page = rows.slice(0, HISTORY_PAGE);
  const items: HistoryRow[] = page.map((r) => {
    const b = r.body as unknown as ReceiptBody;
    const err = b.execution?.error;
    return {
      receiptId: r.id,
      proposalId: r.proposalId,
      kind: r.kind,
      finalState: r.finalState as ProposalState,
      createdAt: r.createdAt,
      summary: b.action.summary,
      destination: b.action.destination,
      client: b.client.label,
      decidedBy: b.decision.by?.name ?? null,
      recovery: err ? { title: err.title, recovery: err.recovery } : null,
    };
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > HISTORY_PAGE && last
        ? Buffer.from(JSON.stringify({ t: last.createdAt.toISOString(), id: last.id })).toString(
            "base64url",
          )
        : null,
  };
}
