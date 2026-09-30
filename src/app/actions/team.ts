"use server";

import { revalidatePath } from "next/cache";
import { requireActiveContext } from "@/server/active-workspace";
import {
  WorkspaceError,
  acceptInvitation,
  changeMemberRole,
  inviteMember,
  removeMember,
  revokeInvitation,
  setApprovalCapabilities,
  ROLES,
  type Role,
} from "@/server/workspaces";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/session";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function fail(e: unknown): ActionResult {
  if (e instanceof WorkspaceError) return { ok: false, error: e.message };
  console.error("team action failed");
  return { ok: false, error: "Something went wrong. Nothing was changed." };
}

const asRole = (v: FormDataEntryValue | null): Role => {
  const r = String(v ?? "");
  return (ROLES as readonly string[]).includes(r) ? (r as Role) : "member";
};

export async function inviteAction(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const { user, workspace } = await requireActiveContext();
    const r = await inviteMember(
      user.id,
      workspace.id,
      String(form.get("email") ?? ""),
      asRole(form.get("role")),
    );
    revalidatePath("/team");
    return {
      ok: true,
      message: r.emailed ? "Invitation emailed." : `Invitation created. Share this link: ${r.url}`,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function changeRoleAction(form: FormData) {
  const { user, workspace } = await requireActiveContext();
  await changeMemberRole(
    user.id,
    workspace.id,
    String(form.get("userId")),
    asRole(form.get("role")),
  );
  revalidatePath("/team");
}

export async function removeMemberAction(form: FormData) {
  const { user, workspace } = await requireActiveContext();
  await removeMember(user.id, workspace.id, String(form.get("userId")));
  revalidatePath("/team");
}

export async function revokeInvitationAction(form: FormData) {
  const { user, workspace } = await requireActiveContext();
  await revokeInvitation(user.id, workspace.id, String(form.get("invitationId")));
  revalidatePath("/team");
}

export async function acceptInvitationAction(form: FormData) {
  const user = await requireUser();
  try {
    await acceptInvitation(user.id, String(form.get("token")));
  } catch (e) {
    const msg = e instanceof WorkspaceError ? e.message : "Invitation could not be accepted";
    redirect(`/inbox?invite_error=${encodeURIComponent(msg)}`);
  }
  redirect("/inbox");
}

export async function setApprovalScopeAction(form: FormData) {
  const { user, workspace } = await requireActiveContext();
  const all = ["github.propose_issue", "slack.propose_message", "email.propose_message"] as const;
  const picked = all.filter((c) => form.get(c) === "on");
  await setApprovalCapabilities(
    user.id,
    workspace.id,
    String(form.get("userId")),
    picked.length === all.length ? null : [...picked],
  );
  revalidatePath("/team");
}
