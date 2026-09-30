"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/session";
import { revokeGrant } from "@/server/mcp-consent";

export async function revokeGrantAction(form: FormData) {
  const user = await requireUser();
  await revokeGrant(user.id, String(form.get("grantId")));
  revalidatePath("/clients");
}
