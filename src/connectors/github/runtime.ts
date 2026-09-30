import { ConnectorError } from "../errors";
import type {
  ConnectorRuntime,
  ExecutionOutcome,
  HealthStepResult,
  HealthTestResult,
  ProposalValidation,
  RuntimeContext,
} from "../types";
import { GithubClient } from "./client";

const step = (
  id: HealthStepResult["id"],
  label: string,
  status: HealthStepResult["status"],
  detail?: string,
): HealthStepResult => ({ id, label, status, detail });

/** Read-only checks. Nothing here creates, edits or deletes anything on GitHub. */
export async function githubHealthTest(ctx: RuntimeContext): Promise<HealthTestResult> {
  const steps: HealthStepResult[] = [];
  let token: string;
  try {
    token = await ctx.getAccessToken();
  } catch (e) {
    const detail =
      e instanceof ConnectorError && e.category === "auth_expired"
        ? "No usable credential is stored. Reconnect GitHub."
        : "The stored credential could not be read.";
    return {
      overall: "fail",
      authFailed: e instanceof ConnectorError && e.category === "auth_expired",
      steps: [
        step("credential", "Credential validity", "fail", detail),
        step("reachability", "API reachability", "skipped"),
        step("identity", "Connected identity", "skipped"),
        step("scopes", "Granted permissions", "skipped"),
        step("destinations", "Repository access", "skipped"),
      ],
    };
  }
  const gh = new GithubClient(ctx.fetch, token);

  const reach = await gh.reachable();
  steps.push(
    reach.ok
      ? step("reachability", "API reachability", "pass", "api.github.com responded.")
      : step(
          "reachability",
          "API reachability",
          "fail",
          reach.status
            ? `GitHub answered with status ${reach.status}.`
            : "GitHub could not be reached.",
        ),
  );
  if (!reach.ok) {
    return {
      overall: "fail",
      steps: [
        step(
          "credential",
          "Credential validity",
          "skipped",
          "Not checked because GitHub was unreachable.",
        ),
        ...steps,
        step("identity", "Connected identity", "skipped"),
        step("scopes", "Granted permissions", "skipped"),
        step("destinations", "Repository access", "skipped"),
      ],
    };
  }

  let user;
  try {
    user = await gh.getUser();
  } catch (e) {
    const auth = e instanceof ConnectorError && e.category === "auth_expired";
    const detail = auth
      ? "GitHub rejected the credential. Reconnect GitHub."
      : e instanceof ConnectorError && e.category === "rate_limited"
        ? "GitHub is rate limiting this account. Try again later."
        : "GitHub could not validate the credential right now.";
    return {
      overall: "fail",
      authFailed: auth,
      steps: [
        step("credential", "Credential validity", "fail", detail),
        ...steps,
        step("identity", "Connected identity", "skipped"),
        step("scopes", "Granted permissions", "skipped"),
        step("destinations", "Repository access", "skipped"),
      ],
    };
  }
  const credential = step(
    "credential",
    "Credential validity",
    "pass",
    "GitHub accepted the credential.",
  );

  // The token must still belong to the account that was connected.
  const sameAccount = user.id === ctx.account.externalAccountId;
  const identity = sameAccount
    ? step("identity", "Connected identity", "pass", `Signed in as ${user.login}.`)
    : step(
        "identity",
        "Connected identity",
        "fail",
        `This token belongs to ${user.login}, not the account that was connected. Reconnect.`,
      );

  const usable = user.scopes.includes("repo") || user.scopes.includes("public_repo");
  const scopes = usable
    ? step(
        "scopes",
        "Granted permissions",
        "pass",
        `GitHub reports: ${user.scopes.join(", ")}.${user.scopes.includes("repo") ? "" : " Private repositories are not included."}`,
      )
    : step(
        "scopes",
        "Granted permissions",
        "fail",
        `GitHub reports: ${user.scopes.join(", ") || "none"}. Issue creation needs repo or public_repo. Reconnect and accept them.`,
      );

  let destinations: HealthStepResult;
  try {
    const { repos, hasMore } = await gh.listRepos(1, 30);
    destinations =
      repos.length > 0
        ? step(
            "destinations",
            "Repository access",
            "pass",
            `${repos.length}${hasMore ? "+" : ""} repositories accessible.`,
          )
        : step(
            "destinations",
            "Repository access",
            "fail",
            "No repositories are accessible with this account.",
          );
  } catch {
    destinations = step(
      "destinations",
      "Repository access",
      "fail",
      "Repositories could not be listed right now.",
    );
  }

  const all = [credential, ...steps, identity, scopes, destinations];
  const failed = all.filter((s) => s.status === "fail").length;
  return {
    overall:
      failed === 0
        ? "pass"
        : credential.status === "pass" && failed < all.length
          ? sameAccount && usable
            ? "partial"
            : "fail"
          : "fail",
    identity: sameAccount ? { displayName: user.login, externalAccountId: user.id } : undefined,
    grantedScopes: user.scopes.length ? user.scopes : undefined,
    steps: all,
  };
}

/** Read-only destination and permission checks for a proposed issue. Creates nothing. */
export async function githubValidateProposal(
  ctx: RuntimeContext,
  args: Record<string, unknown>,
): Promise<ProposalValidation> {
  const owner = String(args.owner);
  const repo = String(args.repo);
  const labels = Array.isArray(args.labels) ? (args.labels as string[]) : [];
  let token: string;
  try {
    token = await ctx.getAccessToken();
  } catch {
    // A local credential problem is not proof the destination is bad; execution re-checks strictly.
    return { status: "unverified", reason: "credential_unavailable" };
  }
  try {
    const gh = new GithubClient(ctx.fetch, token);
    const r = await gh.getRepo(owner, repo);
    if (r.archived)
      return {
        status: "rejected",
        category: "destination_inaccessible",
        message: `${r.fullName} is archived and cannot receive new issues.`,
      };
    if (r.disabled || !r.hasIssues)
      return {
        status: "rejected",
        category: "destination_inaccessible",
        message: `Issues are disabled on ${r.fullName}.`,
      };
    if (r.private && !ctx.account.grantedScopes.includes("repo"))
      return {
        status: "rejected",
        category: "scope_missing",
        message: `${r.fullName} is private, but the connected GitHub account only has access to public repositories.`,
      };
    if (labels.length > 0 && !r.canLabel)
      return {
        status: "rejected",
        category: "scope_missing",
        message: `The connected GitHub identity cannot apply labels on ${r.fullName} (triage access is required). Propose the issue without labels.`,
      };
    return { status: "ok" };
  } catch (e) {
    if (e instanceof ConnectorError) {
      if (e.category === "destination_inaccessible")
        return {
          status: "rejected",
          category: e.category,
          message: `${owner}/${repo} was not found, or the connected GitHub account cannot see it.`,
        };
      if (e.category === "auth_expired")
        return {
          status: "rejected",
          category: e.category,
          message: "The GitHub connection needs to be reconnected.",
        };
      return { status: "unverified", reason: e.category };
    }
    return { status: "unverified", reason: "unexpected_error" };
  }
}

/** Invisible marker that lets us find our own issue later. Disclosed to reviewers on the review screen. */
export const issueMarker = (idempotencyKey: string) => `<!-- ai-action-inbox:${idempotencyKey} -->`;
export const withMarker = (body: string, idempotencyKey: string) =>
  `${body}${body ? "\n\n" : ""}${issueMarker(idempotencyKey)}`;

type IssueArgs = { owner: string; repo: string; title: string; body: string; labels: string[] };

/** The single GitHub write. Called only after approval, claim and re-validation. */
export async function githubCreateIssue(
  ctx: RuntimeContext,
  args: Record<string, unknown>,
  opts: { idempotencyKey: string },
): Promise<ExecutionOutcome> {
  const a = args as unknown as IssueArgs;
  let token: string;
  try {
    token = await ctx.getAccessToken();
  } catch (e) {
    return {
      status: "failed",
      category: e instanceof ConnectorError ? e.category : "auth_expired",
      message: "The GitHub connection needs to be reconnected.",
    };
  }
  try {
    const issue = await new GithubClient(ctx.fetch, token).createIssue(a.owner, a.repo, {
      title: a.title,
      body: withMarker(a.body ?? "", opts.idempotencyKey),
      labels: a.labels ?? [],
    });
    return {
      status: "succeeded",
      providerId: String(issue.number),
      url: issue.url,
      details: { issueNumber: issue.number, issueId: issue.id, repository: `${a.owner}/${a.repo}` },
    };
  } catch (e) {
    if (e instanceof ConnectorError) {
      // maybeDispatched means GitHub may have created the issue: never report failure, never retry.
      if (e.maybeDispatched) return { status: "unknown", reason: e.message };
      return { status: "failed", category: e.category, message: e.message };
    }
    return { status: "unknown", reason: "Unexpected error after the request was sent" };
  }
}

/** Positive-only lookup: finds the issue if it exists; otherwise says nothing. */
export async function githubReconcile(
  ctx: RuntimeContext,
  args: Record<string, unknown>,
  opts: { idempotencyKey: string; since: Date },
): Promise<ExecutionOutcome | null> {
  const a = args as unknown as IssueArgs;
  try {
    const gh = new GithubClient(ctx.fetch, await ctx.getAccessToken());
    const me = await gh.getUser();
    const hit = await gh.findIssueByMarker(
      a.owner,
      a.repo,
      issueMarker(opts.idempotencyKey),
      opts.since,
      me.login,
    );
    return hit
      ? {
          status: "succeeded",
          providerId: String(hit.number),
          url: hit.url,
          details: {
            issueNumber: hit.number,
            issueId: hit.id,
            repository: `${a.owner}/${a.repo}`,
            reconciled: true,
          },
        }
      : null;
  } catch {
    return null;
  }
}

export const githubRuntime: ConnectorRuntime = {
  provider: "github",
  healthTest: githubHealthTest,
  validateProposal: (ctx, _capability, args) => githubValidateProposal(ctx, args),
  execute: (ctx, _capability, args, opts) => githubCreateIssue(ctx, args, opts),
  reconcile: (ctx, _capability, args, opts) =>
    githubReconcile(ctx, args, {
      idempotencyKey: opts.idempotencyKey,
      since: (opts as { since?: Date }).since ?? new Date(Date.now() - 24 * 3600_000),
    }),
};
