import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { workspaceMemberships, workspaces } from "@/db/schema";
import { can, type Capability, type Permission, type Role } from "@/lib/permissions";
import { WorkspaceError } from "./workspaces";

export type Membership = {
  userId: string;
  workspaceId: string;
  role: Role;
  approvalCapabilities: Capability[] | null;
};

/** Current membership read from the database on every call: role changes apply immediately. */
export async function loadMembership(
  userId: string,
  workspaceId: string,
): Promise<Membership | null> {
  const [row] = await getDb()
    .select({ role: workspaceMemberships.role, caps: workspaceMemberships.approvalCapabilities })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId),
        isNull(workspaces.deletedAt),
      ),
    );
  return row ? { userId, workspaceId, role: row.role, approvalCapabilities: row.caps } : null;
}

/**
 * Non-members get "not found" (never confirm a workspace exists); members lacking the
 * permission get "forbidden".
 */
export async function requirePermission(
  userId: string,
  workspaceId: string,
  permission: Permission,
): Promise<Membership> {
  const m = await loadMembership(userId, workspaceId);
  if (!m) throw new WorkspaceError("not_found", "Workspace not found");
  if (!can(m.role, permission))
    throw new WorkspaceError("forbidden", "You do not have permission to do that");
  return m;
}
