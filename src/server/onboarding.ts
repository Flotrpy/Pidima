import "server-only";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  connectorAccounts,
  mcpGrants,
  proposals,
  workspaces,
} from "@/db/schema";
import { requirePermission } from "./authz";

export type StepId = "workspace" | "provider" | "claude" | "test" | "review";
export type StepStatus = "done" | "skipped" | "current" | "todo";

export const STEP_LABELS: Record<StepId, string> = {
  workspace: "Create your workspace",
  provider: "Connect an action provider",
  claude: "Connect Claude",
  test: "Run a safe proposal test",
  review: "Review your first action",
};
const ORDER: StepId[] = ["workspace", "provider", "claude", "test", "review"];

export type OnboardingState = {
  steps: { id: StepId; label: string; status: StepStatus }[];
  current: StepId | null;
  complete: boolean;
  dismissed: boolean;
};

async function exists(q: Promise<{ n: number }[]>) {
  return ((await q)[0]?.n ?? 0) > 0;
}

/**
 * Progress is derived from real facts (connectors, grants, proposals, decisions). The only
 * stored flags are the user's explicit choices to skip providers or dismiss setup.
 */
export async function getOnboardingState(workspaceId: string): Promise<OnboardingState> {
  const db = getDb();
  const [ws] = await db
    .select({ onboarding: workspaces.onboarding })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const flags = ws?.onboarding ?? {};

  const facts: Record<StepId, boolean> = {
    workspace: !!ws,
    provider: await exists(
      db
        .select({ n: count() })
        .from(connectorAccounts)
        .where(
          and(
            eq(connectorAccounts.workspaceId, workspaceId),
            eq(connectorAccounts.status, "active"),
          ),
        ),
    ),
    claude: await exists(
      db
        .select({ n: count() })
        .from(mcpGrants)
        .where(and(eq(mcpGrants.workspaceId, workspaceId), isNull(mcpGrants.revokedAt))),
    ),
    test: await exists(
      db.select({ n: count() }).from(proposals).where(eq(proposals.workspaceId, workspaceId)),
    ),
    review: await exists(
      db
        .select({ n: count() })
        .from(approvalDecisions)
        .innerJoin(proposals, eq(proposals.id, approvalDecisions.proposalId))
        .where(eq(proposals.workspaceId, workspaceId)),
    ),
  };

  let current: StepId | null = null;
  const steps = ORDER.map((id) => {
    let status: StepStatus = facts[id]
      ? "done"
      : id === "provider" && flags.provider === "skipped"
        ? "skipped"
        : "todo";
    if (status === "todo" && current === null) {
      current = id;
      status = "current";
    }
    return { id, label: STEP_LABELS[id], status };
  });
  return { steps, current, complete: current === null, dismissed: flags.dismissed === "skipped" };
}

/** Where an owner should land: setup while it is unfinished and not dismissed, otherwise the inbox. */
export function landingPath(state: OnboardingState, isOwner: boolean): "/onboarding" | "/inbox" {
  return isOwner && !state.complete && !state.dismissed ? "/onboarding" : "/inbox";
}

export async function skipProviders(actorId: string, workspaceId: string) {
  await requirePermission(actorId, workspaceId, "workspace.manage");
  await getDb()
    .update(workspaces)
    .set({ onboarding: sqlMerge("provider") })
    .where(eq(workspaces.id, workspaceId));
}

export async function dismissOnboarding(actorId: string, workspaceId: string) {
  await requirePermission(actorId, workspaceId, "workspace.manage");
  await getDb()
    .update(workspaces)
    .set({ onboarding: sqlMerge("dismissed") })
    .where(eq(workspaces.id, workspaceId));
}

function sqlMerge(key: "provider" | "dismissed") {
  return sql`${workspaces.onboarding} || ${JSON.stringify({ [key]: "skipped" })}::jsonb` as unknown as Record<
    string,
    "done" | "skipped"
  >;
}
