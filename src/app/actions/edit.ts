"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCapability } from "@/connectors/registry";
import { formToArgs } from "@/components/inbox/edit-specs";
import { requireActiveContext } from "@/server/active-workspace";
import { EditError, editProposal } from "@/server/edits";
import { getProposalDetail } from "@/server/inbox";

export type EditState = { error: string; fieldErrors: Record<string, string> } | null;

export async function editProposalAction(_: EditState, form: FormData): Promise<EditState> {
  const { user, workspace } = await requireActiveContext();
  const proposalId = String(form.get("proposalId"));
  let capability;
  try {
    capability = (await getProposalDetail(user.id, workspace.id, proposalId)).capability;
  } catch {
    return { error: "This proposal could not be found.", fieldErrors: {} };
  }
  if (!getCapability(capability)) return { error: "Unknown action type.", fieldErrors: {} };
  try {
    await editProposal({
      actorId: user.id,
      workspaceId: workspace.id,
      proposalId,
      expectedVersion: Number(form.get("expectedVersion")),
      args: formToArgs(capability as never, (n) => (form.get(n) as string | null) ?? null),
      reason: String(form.get("reason") ?? "") || undefined,
    });
  } catch (e) {
    if (e instanceof EditError) {
      const fieldErrors: Record<string, string> = {};
      for (const i of (e.details.issues as { path: string; message: string }[] | undefined) ?? [])
        fieldErrors[i.path.split(".")[0]!] = i.message;
      const reasons = (e.details.reasons as { message: string }[] | undefined)
        ?.map((r) => r.message)
        .join(" ");
      return { error: reasons ? `${e.message} ${reasons}` : e.message, fieldErrors };
    }
    throw e;
  }
  revalidatePath(`/inbox/${proposalId}`);
  redirect(`/inbox/${proposalId}`);
}
