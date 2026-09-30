"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActiveContext } from "@/server/active-workspace";
import { dismissOnboarding, skipProviders } from "@/server/onboarding";

export async function skipProvidersAction() {
  const { user, workspace } = await requireActiveContext();
  await skipProviders(user.id, workspace.id);
  revalidatePath("/onboarding");
  redirect("/onboarding");
}

export async function dismissOnboardingAction() {
  const { user, workspace } = await requireActiveContext();
  await dismissOnboarding(user.id, workspace.id);
  redirect("/inbox");
}
