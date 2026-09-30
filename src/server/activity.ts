import "server-only";
import { and, desc, eq, like, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents, users } from "@/db/schema";
import { redact } from "@/lib/redact";
import { requirePermission } from "./authz";
import { decodeKeyset, encodeKeyset, tsEq, tsLt, tsText } from "./keyset";

export const ACTIVITY_CATEGORIES = {
  all: { label: "Everything", prefix: null },
  proposals: { label: "Requests and decisions", prefix: "proposal." },
  execution: { label: "Execution", prefix: "execution." },
  connectors: { label: "Connections", prefix: "connector." },
  clients: { label: "AI clients", prefix: "mcp." },
  team: { label: "Team and invitations", prefix: "member." },
  policy: { label: "Policies", prefix: "policy." },
} as const;
export type ActivityCategory = keyof typeof ACTIVITY_CATEGORIES;
export const isActivityCategory = (v: unknown): v is ActivityCategory =>
  typeof v === "string" && Object.hasOwn(ACTIVITY_CATEGORIES, v);
export const ACTIVITY_PAGE = 40;

export type ActivityRow = {
  id: string;
  at: Date;
  action: string;
  actor: string;
  subjectType: string | null;
  subjectId: string | null;
  correlationId: string | null;
  detail: Record<string, unknown>;
};

const HUMAN: Record<string, string> = {
  "proposal.created": "AI proposed an action",
  "proposal.submit": "Submitted for review",
  "proposal.approved": "Approved",
  "proposal.denied": "Denied",
  "proposal.canceled": "Canceled",
  "proposal.expire": "Expired",
  "proposal.edited": "Edited by a person",
  "proposal.edit": "Edited by a person",
  "execution.claimed": "Execution started",
  "execution.succeeded": "Execution succeeded",
  "execution.failed": "Execution failed",
  "execution.unknown": "Outcome unknown",
  "execution.reconciled": "Outcome confirmed by reconciliation",
  "connector.connected": "Connection added",
  "connector.reconnected": "Connection renewed",
  "connector.tested": "Connection tested",
  "connector.needs_reauth": "Connection needs reauthorization",
  "connector.revoked": "Connection revoked",
  "connector.disconnected": "Connection disconnected",
  "member.invited": "Member invited",
  "member.joined": "Member joined",
  "member.role_changed": "Role changed",
  "member.removed": "Member removed",
  "mcp.grant_created": "AI client authorized",
  "mcp.grant_revoked_by_user": "AI client access revoked",
  "policy.capability_updated": "Policy updated",
  "policy.rule_set": "Rule added or changed",
  "policy.rule_removed": "Rule removed",
};
export const describeAction = (a: string) => HUMAN[a] ?? a.replace(/[._]/g, " ");

/** Workspace-scoped, newest first, keyset-paginated. Detail is re-redacted on the way out. */
export async function listActivity(
  actorId: string,
  workspaceId: string,
  category: ActivityCategory = "all",
  cursor?: string,
  correlationId?: string,
) {
  await requirePermission(actorId, workspaceId, "activity.view");
  const c = decodeKeyset(cursor);
  const prefix = ACTIVITY_CATEGORIES[category].prefix;
  const rows = await getDb()
    .select({ e: auditEvents, userName: users.name, ts: tsText(auditEvents.createdAt) })
    .from(auditEvents)
    .leftJoin(
      users,
      and(eq(auditEvents.actorType, "user"), sql`${users.id} = ${auditEvents.actorId}`),
    )
    .where(
      and(
        eq(auditEvents.workspaceId, workspaceId),
        prefix ? like(auditEvents.action, `${prefix}%`) : undefined,
        correlationId ? eq(auditEvents.correlationId, correlationId.slice(0, 64)) : undefined,
        c
          ? or(
              tsLt(auditEvents.createdAt, c.t),
              and(tsEq(auditEvents.createdAt, c.t), lt(auditEvents.id, c.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(ACTIVITY_PAGE + 1);
  const page = rows.slice(0, ACTIVITY_PAGE);
  const items: ActivityRow[] = page.map(({ e, userName }) => ({
    id: e.id,
    at: e.createdAt,
    action: e.action,
    actor:
      e.actorType === "user"
        ? (userName ?? "A person")
        : e.actorType === "mcp_client"
          ? "AI client"
          : "System",
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    correlationId: e.correlationId,
    detail: redact(e.detail) as Record<string, unknown>,
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > ACTIVITY_PAGE && last ? encodeKeyset(last.ts, last.e.id) : null,
  };
}

export const DEFAULT_AUDIT_RETENTION_DAYS = 400;

/**
 * Deletes audit events older than the retention period. The append-only trigger only allows deletes
 * inside a transaction that explicitly opts in, so nothing else in the application can purge.
 */
export async function purgeExpiredAuditEvents(
  days = DEFAULT_AUDIT_RETENTION_DAYS,
  now = new Date(),
): Promise<number> {
  if (!Number.isInteger(days) || days < 30)
    throw new Error("Audit retention must be at least 30 days");
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local app.retention_purge = 'on'`);
    const rows = await tx
      .delete(auditEvents)
      .where(lt(auditEvents.createdAt, cutoff))
      .returning({ id: auditEvents.id });
    return rows.length;
  });
}
