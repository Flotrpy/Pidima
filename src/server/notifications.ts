import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  notifications,
  proposals,
  users,
  workspaceMemberships,
  workspaces,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { canDecide, type Capability, type Role } from "@/lib/permissions";
import { logEvent } from "./log";
import { sendMail } from "./mailer";
import { onProposalCreated } from "./proposals";

type Kind = "review_requested" | "execution_failed" | "outcome_unknown" | "connector_unhealthy";
const EMAIL_COOLDOWN_MS = 5 * 60_000;

const link = (path: string) => `${getEnv().APP_URL.replace(/\/$/, "")}${path}`;

/**
 * Email copy is deliberately content-free: it says that something needs attention and links to the
 * authenticated page. It never contains destinations, message text, recipients or titles.
 */
export function emailCopy(kind: Kind, workspaceName: string, path: string, pendingCount: number) {
  const url = link(path);
  switch (kind) {
    case "review_requested":
      return {
        subject: "An AI request is waiting for your review",
        text: `${pendingCount > 1 ? `${pendingCount} AI requests are` : "An AI request is"} waiting for your review in ${workspaceName}.\n\nOpen it (sign-in required): ${url}\n\nNothing happens until someone approves the exact request. This link does not approve anything.`,
      };
    case "execution_failed":
      return {
        subject: "An approved AI action did not complete",
        text: `An approved action in ${workspaceName} did not complete. Nothing further will be attempted automatically.\n\nDetails (sign-in required): ${url}`,
      };
    case "outcome_unknown":
      return {
        subject: "An approved AI action needs verification",
        text: `The provider did not confirm the result of an approved action in ${workspaceName}. Please verify at the destination before trying again.\n\nDetails (sign-in required): ${url}`,
      };
    case "connector_unhealthy":
      return {
        subject: "A connection needs to be reconnected",
        text: `A connected account in ${workspaceName} needs attention.\n\nReconnect (sign-in required): ${url}`,
      };
  }
}

/** Inserts an in-app notification (deduplicated per user+key) and emails at most once per cooldown. */
export async function notifyUser(input: {
  workspaceId: string;
  userId: string;
  kind: Kind;
  proposalId?: string;
  dedupeKey: string;
  path: string;
}): Promise<"created" | "duplicate"> {
  const db = getDb();
  const [row] = await db
    .insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: input.kind,
      proposalId: input.proposalId ?? null,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return "duplicate";

  try {
    const [u] = await db
      .select({ email: users.email, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, input.userId));
    const [ws] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    if (!u?.verified) return "created";
    // Grouping: if we already emailed this user recently about this kind, stay in-app only.
    const recent = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, input.userId),
          eq(notifications.kind, input.kind),
          gt(notifications.emailedAt, new Date(Date.now() - EMAIL_COOLDOWN_MS)),
        ),
      )
      .limit(1);
    if (recent.length > 0) return "created";
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, input.userId),
          eq(notifications.kind, input.kind),
          isNull(notifications.readAt),
        ),
      )) as [{ n: number }];
    const copy = emailCopy(input.kind, ws?.name ?? "your workspace", input.path, n);
    await sendMail({ to: u.email, ...copy });
    await db
      .update(notifications)
      .set({ emailedAt: new Date() })
      .where(eq(notifications.id, row.id));
  } catch {
    logEvent("notification.email_failed", { workspaceId: input.workspaceId, kind: input.kind });
  }
  return "created";
}

async function deciders(
  workspaceId: string,
  capability: Capability,
  excludeUserId?: string | null,
  allowSelf = true,
) {
  const rows = await getDb()
    .select({
      userId: workspaceMemberships.userId,
      role: workspaceMemberships.role,
      caps: workspaceMemberships.approvalCapabilities,
    })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, workspaceId));
  return rows
    .filter(
      (m) =>
        canDecide(m.role as Role, m.caps, capability) && (allowSelf || m.userId !== excludeUserId),
    )
    .map((m) => m.userId);
}

export async function notifyReviewRequested(proposalId: string) {
  const [p] = await getDb().select().from(proposals).where(eq(proposals.id, proposalId));
  if (!p) return;
  const { capabilityPolicies } = await import("@/db/schema");
  const [pol] = await getDb()
    .select()
    .from(capabilityPolicies)
    .where(
      and(
        eq(capabilityPolicies.workspaceId, p.workspaceId),
        eq(capabilityPolicies.capability, p.capability),
      ),
    );
  // Only people who are actually allowed to decide it (and not the requester, when self-approval is off).
  for (const userId of await deciders(
    p.workspaceId,
    p.capability,
    p.initiatedByUserId,
    pol?.allowSelfApproval ?? false,
  )) {
    await notifyUser({
      workspaceId: p.workspaceId,
      userId,
      kind: "review_requested",
      proposalId,
      dedupeKey: `review:${proposalId}`,
      path: `/inbox/${proposalId}`,
    });
  }
}

/** Who should hear that an approved action failed or is unknown: the approver and the requester. */
export async function notifyExecutionOutcome(proposalId: string, outcome: "failed" | "unknown") {
  const db = getDb();
  const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!p) return;
  const approvals = await db
    .select({ u: approvalDecisions.decidedByUserId })
    .from(approvalDecisions)
    .where(
      and(eq(approvalDecisions.proposalId, proposalId), eq(approvalDecisions.decision, "approve")),
    );
  const who = new Set<string>([
    ...approvals.map((a) => a.u),
    ...(p.initiatedByUserId ? [p.initiatedByUserId] : []),
  ]);
  const kind: Kind = outcome === "failed" ? "execution_failed" : "outcome_unknown";
  for (const userId of who)
    await notifyUser({
      workspaceId: p.workspaceId,
      userId,
      kind,
      proposalId,
      dedupeKey: `${kind}:${proposalId}`,
      path: `/inbox/${proposalId}`,
    });
}

export async function notifyConnectorUnhealthy(workspaceId: string, connectorAccountId: string) {
  const owners = await getDb()
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.role, "owner"),
      ),
    );
  for (const o of owners)
    await notifyUser({
      workspaceId,
      userId: o.userId,
      kind: "connector_unhealthy",
      dedupeKey: `connector:${connectorAccountId}`,
      path: "/connections",
    });
}

let stop: (() => void) | null = null;
/** Subscribes to proposal creation. Idempotent; returns an unsubscribe for tests and shutdown. */
export function startNotifications(): () => void {
  if (!stop) {
    const off = onProposalCreated(async ({ proposalId }) => notifyReviewRequested(proposalId));
    stop = () => {
      off();
      stop = null;
    };
  }
  return stop;
}

export async function listNotifications(userId: string, limit = 30) {
  return getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}
export async function unreadCount(userId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r?.n ?? 0;
}
export async function markAllRead(userId: string) {
  await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
