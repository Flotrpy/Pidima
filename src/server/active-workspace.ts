import "server-only";
import { cookies } from "next/headers";
import { listMemberships, type Role } from "./workspaces";
import { requireUser, type SessionUser } from "./session";

export const ACTIVE_WORKSPACE_COOKIE = "active_workspace";

export type ActiveContext = {
  user: SessionUser;
  workspace: { id: string; name: string; isPersonal: boolean };
  role: Role;
};

/**
 * Resolves the workspace for this request. The cookie is only a preference: it is honoured
 * solely if the signed-in user is currently a member, otherwise the first membership is used.
 */
export async function requireActiveContext(): Promise<ActiveContext> {
  const user = await requireUser();
  const memberships = await listMemberships(user.id);
  const preferred = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const chosen = memberships.find((m) => m.workspace.id === preferred) ?? memberships[0];
  if (!chosen) throw new Error("User has no workspace");
  return {
    user,
    workspace: {
      id: chosen.workspace.id,
      name: chosen.workspace.name,
      isPersonal: chosen.workspace.isPersonal,
    },
    role: chosen.role,
  };
}
