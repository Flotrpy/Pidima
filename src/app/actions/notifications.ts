"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/session";
import { markAllRead } from "@/server/notifications";

export async function markNotificationsReadAction() {
  const user = await requireUser();
  await markAllRead(user.id);
  revalidatePath("/notifications");
}
