"use server";

import { revalidatePath } from "next/cache";
import { ConnectorError } from "@/connectors/errors";
import type { HealthTestResult } from "@/connectors/types";
import { requireActiveContext } from "@/server/active-workspace";
import { disconnectConnector, testConnector } from "@/server/connectors";
import { WorkspaceError } from "@/server/workspaces";

export type TestActionState =
  { ok: true; result: HealthTestResult } | { ok: false; error: string } | null;

export async function testConnectionAction(
  _: TestActionState,
  form: FormData,
): Promise<TestActionState> {
  try {
    const { user } = await requireActiveContext();
    const result = await testConnector(user.id, String(form.get("accountId")));
    revalidatePath("/connections");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof WorkspaceError) return { ok: false, error: e.message };
    if (e instanceof ConnectorError) return { ok: false, error: e.message };
    return { ok: false, error: "The test could not run. Nothing was changed at the provider." };
  }
}

export async function disconnectAction(form: FormData) {
  const { user } = await requireActiveContext();
  await disconnectConnector(user.id, String(form.get("accountId")));
  revalidatePath("/connections");
}
