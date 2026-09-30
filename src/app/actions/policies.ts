"use server";

import { revalidatePath } from "next/cache";
import { isCapability } from "@/lib/permissions";
import { requireActiveContext } from "@/server/active-workspace";
import { removeResourceRule, setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { WorkspaceError } from "@/server/workspaces";
import type { Effect, ResourceKind } from "@/approvals/policy";

export type PolicyActionState = { ok: boolean; message: string } | null;

const fail = (e: unknown): PolicyActionState => ({
  ok: false,
  message: e instanceof WorkspaceError ? e.message : "That change could not be saved.",
});

export async function saveCapabilityAction(
  _: PolicyActionState,
  form: FormData,
): Promise<PolicyActionState> {
  try {
    const { user, workspace } = await requireActiveContext();
    const capability = String(form.get("capability"));
    if (!isCapability(capability)) return { ok: false, message: "Unknown action type." };
    await updateCapabilityPolicy(user.id, workspace.id, capability, {
      enabled: form.get("enabled") === "on",
      allowSelfApproval: form.get("allowSelfApproval") === "on",
      expirySeconds: Number(form.get("expirySeconds")),
    });
    revalidatePath("/policies");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

const KINDS: ResourceKind[] = ["github_repo", "slack_channel", "email_sender", "email_domain"];

export async function setRuleAction(
  _: PolicyActionState,
  form: FormData,
): Promise<PolicyActionState> {
  try {
    const { user, workspace } = await requireActiveContext();
    const kind = String(form.get("kind")) as ResourceKind;
    const effect = String(form.get("effect")) as Effect;
    if (!KINDS.includes(kind) || !["allow", "warn", "block"].includes(effect))
      return { ok: false, message: "Invalid rule." };
    await setResourceRule(user.id, workspace.id, {
      kind,
      effect,
      value: String(form.get("value") ?? ""),
      connectorAccountId: String(form.get("connectorAccountId") ?? "") || null,
    });
    revalidatePath("/policies");
    return { ok: true, message: "Rule saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function removeRuleAction(form: FormData) {
  const { user, workspace } = await requireActiveContext();
  await removeResourceRule(user.id, workspace.id, String(form.get("ruleId")));
  revalidatePath("/policies");
}
