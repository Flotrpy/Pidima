import "server-only";
import { and, asc, count, desc, eq, gt, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  connectorAccounts,
  executions,
  proposalVersions,
  proposals,
  users,
} from "@/db/schema";
import { getCapability } from "@/connectors/registry";
import type { ProposalState } from "@/components/ui/status";
import type { ReviewField } from "@/connectors/types";
import { hasHiddenDirectionControls } from "@/lib/time";
import { requirePermission } from "./authz";
import { identityNote, listConnectors } from "./connectors";
import { evaluateForProposal } from "./policy";
import { expireIfDue } from "./proposals";
import { WorkspaceError } from "./workspaces";

export const FILTERS = {
  needs_review: { label: "Needs review", states: ["PENDING_APPROVAL"] },
  executing: { label: "Approved / executing", states: ["APPROVED", "EXECUTING"] },
  completed: { label: "Completed", states: ["SUCCEEDED"] },
  failed: { label: "Failed", states: ["FAILED"] },
  unknown: { label: "Outcome unknown", states: ["OUTCOME_UNKNOWN"] },
  denied: { label: "Denied or canceled", states: ["DENIED", "CANCELED"] },
  expired: { label: "Expired", states: ["EXPIRED"] },
} as const satisfies Record<string, { label: string; states: readonly ProposalState[] }>;
export type FilterKey = keyof typeof FILTERS;
export const isFilterKey = (v: unknown): v is FilterKey =>
  typeof v === "string" && Object.hasOwn(FILTERS, v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);
export const PAGE_SIZE = 25;

export type InboxRow = {
  id: string;
  capability: string;
  title: string;
  destination: string;
  clientLabel: string;
  requestedBy: string | null;
  state: ProposalState;
  createdAt: Date;
  expiresAt: Date;
  /** Pending and expiring within 15 minutes. Computed server-side so rendering stays pure. */
  urgent: boolean;
};

const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString("base64url");
function decodeCursor(c: string | undefined): { t: Date; id: string } | null {
  if (!c) return null;
  try {
    const { t, id } = JSON.parse(Buffer.from(c, "base64url").toString());
    return typeof t === "string" &&
      typeof id === "string" &&
      isUuid(id) &&
      !Number.isNaN(Date.parse(t))
      ? { t: new Date(t), id }
      : null;
  } catch {
    return null;
  }
}

/** Keyset-paginated queue. Only the requested workspace's rows are ever selectable. */
export async function listProposals(
  actorId: string,
  workspaceId: string,
  filter: FilterKey,
  cursor?: string,
  q?: string,
) {
  await requirePermission(actorId, workspaceId, "proposals.view");
  const db = getDb();
  const c = decodeCursor(cursor);
  // Work that needs a person is ordered by urgency (soonest expiry first); history is newest first.
  const byExpiry = filter === "needs_review";
  const sortCol = byExpiry ? proposals.expiresAt : proposals.createdAt;
  const term = q?.trim().slice(0, 80);
  const like = term ? `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await db
    .select({ p: proposals, v: proposalVersions, initiator: users.name })
    .from(proposals)
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.proposalId, proposals.id),
        eq(proposalVersions.version, proposals.currentVersion),
      ),
    )
    .leftJoin(users, eq(users.id, proposals.initiatedByUserId))
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        inArray(proposals.state, [...FILTERS[filter].states]),
        c
          ? byExpiry
            ? or(gt(sortCol, c.t), and(eq(sortCol, c.t), gt(proposals.id, c.id)))
            : or(lt(sortCol, c.t), and(eq(sortCol, c.t), lt(proposals.id, c.id)))
          : undefined,
        like
          ? or(
              ilike(proposalVersions.destination, like),
              ilike(proposals.clientLabel, like),
              ilike(users.name, like),
              ilike(sql`${proposals.capability}::text`, like),
            )
          : undefined,
      ),
    )
    .orderBy(
      ...(byExpiry ? [asc(sortCol), asc(proposals.id)] : [desc(sortCol), desc(proposals.id)]),
    )
    .limit(PAGE_SIZE + 1);

  const page = rows.slice(0, PAGE_SIZE);
  const items: InboxRow[] = page.map(({ p, v, initiator }) => ({
    id: p.id,
    capability: p.capability,
    title: getCapability(p.capability)?.title ?? p.capability,
    destination: v.destination,
    clientLabel: p.clientLabel,
    requestedBy: initiator,
    state: p.state as ProposalState,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    urgent: p.state === "PENDING_APPROVAL" && p.expiresAt.getTime() - Date.now() < 15 * 60_000,
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? encodeCursor(byExpiry ? last.p.expiresAt : last.p.createdAt, last.p.id)
        : null,
  };
}

export async function countsByFilter(
  actorId: string,
  workspaceId: string,
): Promise<Record<FilterKey, number>> {
  await requirePermission(actorId, workspaceId, "proposals.view");
  const rows = await getDb()
    .select({ state: proposals.state, n: count() })
    .from(proposals)
    .where(eq(proposals.workspaceId, workspaceId))
    .groupBy(proposals.state);
  const byState = new Map(rows.map((r) => [r.state, r.n]));
  return Object.fromEntries(
    (Object.keys(FILTERS) as FilterKey[]).map((k) => [
      k,
      FILTERS[k].states.reduce((a, s) => a + (byState.get(s) ?? 0), 0),
    ]),
  ) as Record<FilterKey, number>;
}

export type OperationalSummary = {
  needsReview: number;
  executing: number;
  failed: number;
  outcomeUnknown: number;
  connectorProblems: number;
  lastVerifiedActivity: Date | null;
  expiringSoon: number;
};

/** The returning-user "what needs me" strip. */
export async function getOperationalSummary(
  actorId: string,
  workspaceId: string,
): Promise<OperationalSummary> {
  const counts = await countsByFilter(actorId, workspaceId);
  const connectors = await listConnectors(actorId, workspaceId);
  const [last] = await getDb()
    .select({ at: executions.finishedAt })
    .from(executions)
    .innerJoin(proposals, eq(proposals.id, executions.proposalId))
    .where(and(eq(proposals.workspaceId, workspaceId), eq(executions.state, "SUCCEEDED")))
    .orderBy(desc(executions.finishedAt))
    .limit(1);
  const [soon] = await getDb()
    .select({ n: count() })
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        eq(proposals.state, "PENDING_APPROVAL"),
        sql`${proposals.expiresAt} < now() + interval '15 minutes'`,
      ),
    );
  return {
    needsReview: counts.needs_review,
    executing: counts.executing,
    failed: counts.failed,
    outcomeUnknown: counts.unknown,
    connectorProblems: connectors.filter(
      (c) => c.health === "needs_reauth" || c.health === "degraded",
    ).length,
    lastVerifiedActivity: last?.at ?? null,
    expiringSoon: soon?.n ?? 0,
  };
}

export type ProposalDetail = {
  id: string;
  workspaceId: string;
  capability: string;
  title: string;
  verb: string;
  state: ProposalState;
  clientLabel: string;
  requestedBy: string | null;
  requestedById: string | null;
  createdAt: Date;
  expiresAt: Date;
  version: number;
  versions: {
    version: number;
    authorType: "ai" | "human";
    authorName: string | null;
    createdAt: Date;
    status: "current" | "superseded";
  }[];
  destination: string;
  fields: ReviewField[];
  consequences: string[];
  warnings: { code: string; message: string }[];
  blockers: { code: string; message: string }[];
  connector: {
    id: string;
    displayName: string;
    provider: string;
    grantedScopes: string[];
    status: string;
  };
  requiredScopes: string[];
  /** Who/what the action will appear to come from (e.g. Slack app vs. a person). */
  senderNote: string | null;
  display: Record<string, string>;
  hiddenDirectionWarning: boolean;
  args: Record<string, unknown>;
  /** The AI's first version, kept so reviewers and receipts can see what a person changed. */
  originalArgs: Record<string, unknown>;
  decisions: { decision: string; by: string; at: Date; reason: string | null }[];
  execution: {
    state: string;
    startedAt: Date;
    finishedAt: Date | null;
    errorCategory: string | null;
  } | null;
};

/**
 * Everything the reviewer needs on one screen. Non-members and other workspaces' proposals are
 * indistinguishable from missing ones.
 */
export async function getProposalDetail(
  actorId: string,
  workspaceId: string,
  proposalId: string,
): Promise<ProposalDetail> {
  await requirePermission(actorId, workspaceId, "proposals.view");
  if (!isUuid(proposalId)) throw new WorkspaceError("not_found", "Proposal not found");
  await expireIfDue(proposalId).catch(() => false);

  const db = getDb();
  const [row] = await db
    .select({ p: proposals, initiator: users.name })
    .from(proposals)
    .leftJoin(users, eq(users.id, proposals.initiatedByUserId))
    .where(and(eq(proposals.id, proposalId), eq(proposals.workspaceId, workspaceId)));
  if (!row) throw new WorkspaceError("not_found", "Proposal not found");
  const { p } = row;
  const def = getCapability(p.capability);
  if (!def) throw new WorkspaceError("not_found", "Proposal not found");

  const versions = await db
    .select({ v: proposalVersions, authorName: users.name })
    .from(proposalVersions)
    .leftJoin(users, eq(users.id, proposalVersions.authorUserId))
    .where(eq(proposalVersions.proposalId, p.id))
    .orderBy(desc(proposalVersions.version));
  const current = versions.find((x) => x.v.version === p.currentVersion)?.v;
  if (!current) throw new WorkspaceError("not_found", "Proposal not found");
  const args = current.args as Record<string, unknown>;

  const [conn] = await db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, p.connectorAccountId));
  const decisions = await db
    .select({ d: approvalDecisions, by: users.name })
    .from(approvalDecisions)
    .innerJoin(users, eq(users.id, approvalDecisions.decidedByUserId))
    .where(eq(approvalDecisions.proposalId, p.id))
    .orderBy(desc(approvalDecisions.createdAt));
  const [exec] = await db
    .select()
    .from(executions)
    .where(eq(executions.proposalId, p.id))
    .orderBy(desc(executions.startedAt))
    .limit(1);

  // Live policy view for this reader: warnings to show, and blockers explaining why deciding may be impossible.
  const policy =
    p.state === "PENDING_APPROVAL" ? await evaluateForProposal("decide", p, args, actorId) : null;
  const display = (current.display ?? {}) as Record<string, string>;
  // Show the resolved, human-friendly name next to the canonical ID the system will actually use.
  const fields = def
    .reviewFields(args as never)
    .map((f) =>
      f.label === "Channel" && display.channelName
        ? { ...f, value: `${display.channelName} (${String(f.value)})` }
        : f,
    );
  const flat = fields.flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]));

  return {
    id: p.id,
    workspaceId: p.workspaceId,
    capability: p.capability,
    title: def.title,
    verb: def.verb,
    state: p.state as ProposalState,
    clientLabel: p.clientLabel,
    requestedBy: row.initiator,
    requestedById: p.initiatedByUserId,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    version: p.currentVersion,
    versions: versions.map(({ v, authorName }) => ({
      version: v.version,
      authorType: v.authorType,
      authorName,
      createdAt: v.createdAt,
      status: v.version === p.currentVersion ? "current" : "superseded",
    })),
    destination: display.channelName
      ? `${display.channelName}${display.workspace ? ` · ${display.workspace}` : ""}`
      : current.destination,
    fields,
    consequences: def.consequences(args as never),
    warnings: policy?.warnings.map((w) => ({ code: w.code, message: w.message })) ?? [],
    blockers: policy?.reasons.map((r) => ({ code: r.code, message: r.message })) ?? [],
    connector: {
      id: conn?.id ?? p.connectorAccountId,
      displayName: conn?.displayName ?? "Unknown account",
      provider: conn?.provider ?? "unknown",
      grantedScopes: conn?.grantedScopes ?? [],
      status: conn?.status ?? "disconnected",
    },
    requiredScopes: def.requiredScopes,
    senderNote: conn ? identityNote(conn.provider, conn.metadata) : null,
    display,
    hiddenDirectionWarning: hasHiddenDirectionControls(...flat),
    args,
    originalArgs: (versions.find((x) => x.v.version === 1)?.v.args ?? args) as Record<
      string,
      unknown
    >,
    decisions: decisions.map(({ d, by }) => ({
      decision: d.decision,
      by,
      at: d.createdAt,
      reason: d.reason,
    })),
    execution: exec
      ? {
          state: exec.state,
          startedAt: exec.startedAt,
          finishedAt: exec.finishedAt,
          errorCategory: exec.errorCategory,
        }
      : null,
  };
}
