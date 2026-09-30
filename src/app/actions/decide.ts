"use server";

import { revalidatePath } from "next/cache";
import { requireActiveContext } from "@/server/active-workspace";
import { DecisionError, decideProposal } from "@/server/decisions";

export type DecideState = { ok: boolean; message: string } | null;

const MESSAGES = {
  approved: "Approved. Execution will start shortly; the result and receipt appear on this page.",
  denied: "Denied. Nothing was sent or created.",
  canceled: "Canceled. Nothing was sent or created.",
  already_approved: "Already approved. Showing the current status.",
  already_denied: "Already denied.",
  already_canceled: "Already canceled.",
} as const;

export async function decideAction(_: DecideState, form: FormData): Promise<DecideState> {
  const { user, workspace } = await requireActiveContext();
  const decision = String(form.get("decision"));
  if (decision !== "approve" && decision !== "deny" && decision !== "cancel")
    return { ok: false, message: "Unknown decision." };
  const proposalId = String(form.get("proposalId"));
  try {
    const r = await decideProposal({
      actorId: user.id,
      workspaceId: workspace.id,
      proposalId,
      decision,
      expectedVersion: Number(form.get("expectedVersion")),
      reason: String(form.get("reason") ?? "").trim() || undefined,
    });
    revalidatePath(`/inbox/${proposalId}`);
    revalidatePath("/inbox");
    return { ok: true, message: MESSAGES[r.status] };
  } catch (e) {
    revalidatePath(`/inbox/${proposalId}`);
    if (e instanceof DecisionError) {
      const reasons = (e.details.reasons as { message: string }[] | undefined)
        ?.map((r) => r.message)
        .join(" ");
      return { ok: false, message: reasons ? `${e.message} ${reasons}` : e.message };
    }
    console.error("decision failed");
    return { ok: false, message: "The decision could not be recorded. Nothing was changed." };
  }
}
