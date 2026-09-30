import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  capabilityPolicies,
  users,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { recordAudit, type Executor } from "./audit";
import { sendMail } from "./mailer";
import { randomToken, sha256 } from "./tokens";

export type Role = "owner" | "approver" | "member" | "viewer";
export const ROLES: readonly Role[] = ["owner", "approver", "member", "viewer"];
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CAPABILITIES = [
  "github.propose_issue",
  "slack.propose_message",
  "email.propose_message",
] as const;

export class WorkspaceError extends Error {
  constructor(
    public code: "forbidden" | "not_found" | "invalid" | "conflict" | "expired",
    message: string,
  ) {
    super(message);
  }
}

function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
  return `${base}-${randomToken(4)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x")}`;
}

/** Creates a workspace with its owner membership and deny-by-default capability policies. */
export async function createWorkspace(
  userId: string,
  name: string,
  opts: { personal?: boolean } = {},
  exec?: Executor,
) {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 80)
    throw new WorkspaceError("invalid", "Workspace name must be 2–80 characters");

  const run = async (tx: Executor) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({
        name: trimmed,
        slug: slugify(trimmed),
        isPersonal: opts.personal ?? false,
        createdByUserId: userId,
      })
      .returning();
    await tx.insert(workspaceMemberships).values({ workspaceId: ws!.id, userId, role: "owner" });
    await tx
      .insert(capabilityPolicies)
      .values(
        CAPABILITIES.map((capability) => ({ workspaceId: ws!.id, capability, enabled: false })),
      );
    await recordAudit(
      {
        workspaceId: ws!.id,
        actorType: "user",
        actorId: userId,
        action: "workspace.created",
        subjectType: "workspace",
        subjectId: ws!.id,
      },
      tx,
    );
    return ws!;
  };
  return exec ? run(exec) : getDb().transaction(run);
}

export async function listMemberships(userId: string) {
  return getDb()
    .select({ workspace: workspaces, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(and(eq(workspaceMemberships.userId, userId), isNull(workspaces.deletedAt)));
}

export async function getMembership(userId: string, workspaceId: string) {
  const [row] = await getDb()
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId),
        isNull(workspaces.deletedAt),
      ),
    );
  return row ?? null;
}

async function requireOwner(actorId: string, workspaceId: string) {
  const m = await getMembership(actorId, workspaceId);
  if (!m) throw new WorkspaceError("not_found", "Workspace not found");
  if (m.role !== "owner") throw new WorkspaceError("forbidden", "Only owners can manage members");
}

export async function inviteMember(
  actorId: string,
  workspaceId: string,
  email: string,
  role: Role,
) {
  await requireOwner(actorId, workspaceId);
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) || normalized.length > 254)
    throw new WorkspaceError("invalid", "Enter a valid email address");
  if (!ROLES.includes(role)) throw new WorkspaceError("invalid", "Unknown role");

  const token = randomToken();
  const [inv] = await getDb()
    .insert(workspaceInvitations)
    .values({
      workspaceId,
      email: normalized,
      role,
      tokenHash: sha256(token),
      invitedByUserId: actorId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();
  await recordAudit({
    workspaceId,
    actorType: "user",
    actorId,
    action: "member.invited",
    subjectType: "invitation",
    subjectId: inv!.id,
    detail: { role },
  });

  const url = `${getEnv().APP_URL}/invite/${token}`;
  let emailed = false;
  try {
    await sendMail({
      to: normalized,
      subject: "You have been invited to an AI Action Inbox workspace",
      text: `You were invited to join a workspace as ${role}.\n\nAccept: ${url}\n\nThe link expires in 7 days and only works when signed in with ${normalized}.`,
    });
    emailed = true;
  } catch {
    // Email is best-effort; the owner can copy the link.
  }
  return { invitationId: inv!.id, url, emailed };
}

export async function acceptInvitation(userId: string, token: string) {
  return getDb().transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, sha256(token)))
      .for("update");
    if (!inv || inv.revokedAt || inv.acceptedAt)
      throw new WorkspaceError("not_found", "Invitation is not valid");
    if (inv.expiresAt.getTime() < Date.now())
      throw new WorkspaceError("expired", "Invitation has expired");

    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user || !user.emailVerified || user.email.toLowerCase() !== inv.email) {
      throw new WorkspaceError(
        "forbidden",
        "Sign in with the invited, verified email address to accept",
      );
    }
    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: inv.workspaceId, userId, role: inv.role })
      .onConflictDoNothing();
    await tx
      .update(workspaceInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(workspaceInvitations.id, inv.id));
    await recordAudit(
      {
        workspaceId: inv.workspaceId,
        actorType: "user",
        actorId: userId,
        action: "member.joined",
        subjectType: "invitation",
        subjectId: inv.id,
        detail: { role: inv.role },
      },
      tx,
    );
    return { workspaceId: inv.workspaceId, role: inv.role };
  });
}

export async function revokeInvitation(actorId: string, workspaceId: string, invitationId: string) {
  await requireOwner(actorId, workspaceId);
  const res = await getDb()
    .update(workspaceInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(workspaceInvitations.id, invitationId),
        eq(workspaceInvitations.workspaceId, workspaceId),
        isNull(workspaceInvitations.acceptedAt),
      ),
    )
    .returning({ id: workspaceInvitations.id });
  if (res.length === 0) throw new WorkspaceError("not_found", "Invitation not found");
  await recordAudit({
    workspaceId,
    actorType: "user",
    actorId,
    action: "invitation.revoked",
    subjectType: "invitation",
    subjectId: invitationId,
  });
}

async function ownerCount(tx: Executor, workspaceId: string) {
  const rows = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.role, "owner"),
      ),
    )
    .for("update");
  return rows.length;
}

export async function changeMemberRole(
  actorId: string,
  workspaceId: string,
  targetUserId: string,
  role: Role,
) {
  await requireOwner(actorId, workspaceId);
  if (!ROLES.includes(role)) throw new WorkspaceError("invalid", "Unknown role");
  await getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, targetUserId),
        ),
      );
    if (!current) throw new WorkspaceError("not_found", "Member not found");
    if (current.role === "owner" && role !== "owner" && (await ownerCount(tx, workspaceId)) <= 1) {
      throw new WorkspaceError("conflict", "A workspace must keep at least one owner");
    }
    await tx
      .update(workspaceMemberships)
      .set({ role })
      .where(eq(workspaceMemberships.id, current.id));
    await recordAudit(
      {
        workspaceId,
        actorType: "user",
        actorId,
        action: "member.role_changed",
        subjectType: "user",
        subjectId: targetUserId,
        detail: { from: current.role, to: role },
      },
      tx,
    );
  });
}

export async function removeMember(actorId: string, workspaceId: string, targetUserId: string) {
  if (actorId !== targetUserId) await requireOwner(actorId, workspaceId);
  await getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, targetUserId),
        ),
      );
    if (!current) throw new WorkspaceError("not_found", "Member not found");
    if (current.role === "owner" && (await ownerCount(tx, workspaceId)) <= 1) {
      throw new WorkspaceError("conflict", "A workspace must keep at least one owner");
    }
    await tx.delete(workspaceMemberships).where(eq(workspaceMemberships.id, current.id));
    await recordAudit(
      {
        workspaceId,
        actorType: "user",
        actorId,
        action: actorId === targetUserId ? "member.left" : "member.removed",
        subjectType: "user",
        subjectId: targetUserId,
      },
      tx,
    );
  });
}

export async function listMembers(actorId: string, workspaceId: string) {
  if (!(await getMembership(actorId, workspaceId)))
    throw new WorkspaceError("not_found", "Workspace not found");
  const members = await getDb()
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: workspaceMemberships.role,
    })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(eq(workspaceMemberships.workspaceId, workspaceId));
  const invitations = await getDb()
    .select({
      id: workspaceInvitations.id,
      email: workspaceInvitations.email,
      role: workspaceInvitations.role,
      expiresAt: workspaceInvitations.expiresAt,
    })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
      ),
    );
  return { members, invitations };
}
