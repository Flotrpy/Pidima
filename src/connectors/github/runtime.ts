import { ConnectorError } from "../errors";
import type {
  ConnectorRuntime,
  HealthStepResult,
  HealthTestResult,
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

export const githubRuntime: ConnectorRuntime = {
  provider: "github",
  healthTest: githubHealthTest,
  async execute() {
    // Issue creation is implemented in P1-042.
    throw new ConnectorError("failed_before_dispatch", "GitHub execution is not available yet");
  },
};
