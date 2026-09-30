import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts } from "@/db/schema";
import { checkResource } from "@/approvals/policy";
import { SlackClient, type SlackChannel } from "@/connectors/slack/client";
import type { SafeFetch } from "@/connectors/types";
import { requirePermission } from "./authz";
import { runtimeContextFor } from "./connectors";
import { loadRules } from "./github-repos";
import { WorkspaceError } from "./workspaces";

export type ChannelChoice = SlackChannel & {
  permitted: boolean;
  reason?: "resource_blocked" | "resource_not_allowed";
};

/**
 * Channels this connection can actually post in (it is a member; not archived), each marked with
 * whether workspace policy permits proposing there. Read-only. Pass `fetchOverride` only in tests.
 */
export async function listChannelChoices(
  actorId: string,
  connectorAccountId: string,
  fetchOverride?: SafeFetch,
): Promise<{ channels: ChannelChoice[]; truncated: boolean }> {
  const [acct] = await getDb()
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, connectorAccountId));
  if (!acct || acct.provider !== "slack")
    throw new WorkspaceError("not_found", "Connection not found");
  try {
    await requirePermission(actorId, acct.workspaceId, "connectors.manage");
  } catch {
    throw new WorkspaceError("not_found", "Connection not found");
  }
  const ctx = runtimeContextFor(acct);
  const client = new SlackClient(fetchOverride ?? ctx.fetch, await ctx.getAccessToken());
  const rules = await loadRules(acct.workspaceId);
  const { channels, truncated } = await client.listChannels();
  return {
    truncated,
    channels: channels
      .filter((c) => c.isMember && !c.isArchived)
      .map((c) => {
        const r = checkResource("slack_channel", c.id, rules, acct.id);
        return { ...c, permitted: r.allowed, reason: r.allowed ? undefined : r.code };
      }),
  };
}
