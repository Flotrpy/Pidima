import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, resourcePolicies } from "@/db/schema";
import { checkResource, type ResourceRule } from "@/approvals/policy";
import { GithubClient, type RepoInfo } from "@/connectors/github/client";
import { ConnectorError } from "@/connectors/errors";
import type { SafeFetch } from "@/connectors/types";
import { requirePermission } from "./authz";
import { runtimeContextFor } from "./connectors";
import { WorkspaceError } from "./workspaces";

async function loadAccount(actorId: string, connectorAccountId: string) {
  const [acct] = await getDb()
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, connectorAccountId));
  if (!acct || acct.provider !== "github")
    throw new WorkspaceError("not_found", "Connection not found");
  try {
    await requirePermission(actorId, acct.workspaceId, "connectors.manage");
  } catch {
    throw new WorkspaceError("not_found", "Connection not found");
  }
  return acct;
}

export async function loadRules(workspaceId: string): Promise<ResourceRule[]> {
  const rows = await getDb()
    .select()
    .from(resourcePolicies)
    .where(eq(resourcePolicies.workspaceId, workspaceId));
  return rows.map((r) => ({
    kind: r.kind,
    value: r.value,
    effect: r.effect,
    connectorAccountId: r.connectorAccountId,
  }));
}

export type RepoChoice = RepoInfo & {
  permitted: boolean;
  reason?: "resource_blocked" | "resource_not_allowed";
};

/**
 * Repositories the connected account can reach, each marked with whether workspace policy permits
 * proposing issues there. Read-only. Pass `fetch` only in tests.
 */
export async function listRepoChoices(
  actorId: string,
  connectorAccountId: string,
  page = 1,
  fetchOverride?: SafeFetch,
): Promise<{ repos: RepoChoice[]; hasMore: boolean }> {
  const acct = await loadAccount(actorId, connectorAccountId);
  const ctx = runtimeContextFor(acct);
  const gh = new GithubClient(fetchOverride ?? ctx.fetch, await ctx.getAccessToken());
  const rules = await loadRules(acct.workspaceId);
  const { repos, hasMore } = await gh.listRepos(page, 30);
  return {
    hasMore,
    repos: repos
      .filter((r) => !r.archived && !r.disabled && r.hasIssues)
      .map((r) => {
        const c = checkResource("github_repo", r.fullName, rules, acct.id);
        return { ...r, permitted: c.allowed, reason: c.allowed ? undefined : c.code };
      }),
  };
}

export type DestinationCheck =
  | { ok: true; repo: RepoInfo }
  | { ok: false; category: ConnectorError["category"]; message: string };

/**
 * Verifies a specific repository is a valid destination right now: reachable with this token,
 * issues enabled, not archived, and (for private repos) covered by the granted scope.
 */
export async function validateGithubDestination(
  connectorAccountId: string,
  owner: string,
  repo: string,
  fetchOverride?: SafeFetch,
): Promise<DestinationCheck> {
  const [acct] = await getDb()
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, connectorAccountId));
  if (!acct || acct.provider !== "github")
    return {
      ok: false,
      category: "destination_inaccessible",
      message: "The GitHub connection was not found.",
    };
  try {
    const ctx = runtimeContextFor(acct);
    const gh = new GithubClient(fetchOverride ?? ctx.fetch, await ctx.getAccessToken());
    const r = await gh.getRepo(owner, repo);
    if (r.archived)
      return {
        ok: false,
        category: "destination_inaccessible",
        message: `${r.fullName} is archived and cannot receive new issues.`,
      };
    if (r.disabled || !r.hasIssues)
      return {
        ok: false,
        category: "destination_inaccessible",
        message: `Issues are disabled on ${r.fullName}.`,
      };
    if (r.private && !acct.grantedScopes.includes("repo"))
      return {
        ok: false,
        category: "scope_missing",
        message: `${r.fullName} is private, but this connection only has access to public repositories.`,
      };
    return { ok: true, repo: r };
  } catch (e) {
    if (e instanceof ConnectorError) {
      const message =
        e.category === "destination_inaccessible"
          ? `${owner}/${repo} was not found or this connection cannot see it.`
          : e.message;
      return { ok: false, category: e.category, message };
    }
    throw e;
  }
}
