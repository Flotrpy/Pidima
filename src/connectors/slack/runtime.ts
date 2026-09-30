import { ConnectorError } from "../errors";
import type {
  ConnectorRuntime,
  HealthStepResult,
  HealthTestResult,
  RuntimeContext,
} from "../types";
import { SlackClient } from "./client";

const step = (
  id: HealthStepResult["id"],
  label: string,
  status: HealthStepResult["status"],
  detail?: string,
): HealthStepResult => ({ id, label, status, detail });
const skipped = (...ids: [HealthStepResult["id"], string][]) =>
  ids.map(([id, label]) => step(id, label, "skipped"));

/** Read-only checks. Never posts a message. */
export async function slackHealthTest(ctx: RuntimeContext): Promise<HealthTestResult> {
  let token: string;
  try {
    token = await ctx.getAccessToken();
  } catch (e) {
    const auth = e instanceof ConnectorError && e.category === "auth_expired";
    return {
      overall: "fail",
      authFailed: auth,
      steps: [
        step(
          "credential",
          "Credential validity",
          "fail",
          auth
            ? "No usable credential is stored. Reconnect Slack."
            : "The stored credential could not be read.",
        ),
        ...skipped(
          ["reachability", "API reachability"],
          ["identity", "Connected identity"],
          ["scopes", "Granted permissions"],
          ["destinations", "Channel access"],
        ),
      ],
    };
  }
  const slack = new SlackClient(ctx.fetch, token);

  const reach = await slack.reachable();
  const reachability = reach.ok
    ? step("reachability", "API reachability", "pass", "slack.com responded.")
    : step(
        "reachability",
        "API reachability",
        "fail",
        reach.status
          ? `Slack answered with status ${reach.status}.`
          : "Slack could not be reached.",
      );
  if (!reach.ok)
    return {
      overall: "fail",
      steps: [
        step(
          "credential",
          "Credential validity",
          "skipped",
          "Not checked because Slack was unreachable.",
        ),
        reachability,
        ...skipped(
          ["identity", "Connected identity"],
          ["scopes", "Granted permissions"],
          ["destinations", "Channel access"],
        ),
      ],
    };

  let who;
  try {
    who = await slack.authTest();
  } catch (e) {
    const auth = e instanceof ConnectorError && e.category === "auth_expired";
    const detail = auth
      ? "Slack no longer accepts this connection. Reconnect Slack."
      : e instanceof ConnectorError && e.category === "rate_limited"
        ? "Slack is rate limiting this connection. Try again later."
        : "Slack could not validate the credential right now.";
    return {
      overall: "fail",
      authFailed: auth,
      steps: [
        step("credential", "Credential validity", "fail", detail),
        reachability,
        ...skipped(
          ["identity", "Connected identity"],
          ["scopes", "Granted permissions"],
          ["destinations", "Channel access"],
        ),
      ],
    };
  }
  const credential = step(
    "credential",
    "Credential validity",
    "pass",
    "Slack accepted the credential.",
  );

  const mode = ctx.account.metadata.senderMode === "user" ? "user" : "bot";
  const expectedTeam = String(ctx.account.metadata.teamId ?? "");
  const expectedUser = String(ctx.account.metadata.userId ?? "");
  const sameTeam = !expectedTeam || who.teamId === expectedTeam;
  const sameSender =
    mode === "bot" ? who.isBot : !who.isBot && (!expectedUser || who.userId === expectedUser);
  const identityOk = sameTeam && sameSender;
  const identity = identityOk
    ? step(
        "identity",
        "Connected identity",
        "pass",
        mode === "bot"
          ? `Acting as the app in ${who.team}.`
          : `Acting as ${who.user} in ${who.team}.`,
      )
    : step(
        "identity",
        "Connected identity",
        "fail",
        "This token no longer matches the workspace or sender that was connected. Reconnect.",
      );

  const canPost = who.scopes.includes("chat:write");
  const canList = who.scopes.includes("channels:read") || who.scopes.includes("groups:read");
  const scopes = canPost
    ? step(
        "scopes",
        "Granted permissions",
        "pass",
        `Slack reports: ${who.scopes.join(", ")}.${canList ? "" : " Channel listing is unavailable without channels:read."}`,
      )
    : step(
        "scopes",
        "Granted permissions",
        "fail",
        `Slack reports: ${who.scopes.join(", ") || "none"}. Posting needs chat:write. Reconnect and accept it.`,
      );

  let destinations: HealthStepResult;
  try {
    const { channels, truncated } = await slack.listChannels(2);
    const usable = channels.filter((c) => c.isMember && !c.isArchived);
    destinations =
      usable.length > 0
        ? step(
            "destinations",
            "Channel access",
            "pass",
            `${usable.length}${truncated ? "+" : ""} channel(s) this connection can post in.`,
          )
        : step(
            "destinations",
            "Channel access",
            "fail",
            mode === "bot"
              ? "The app is not in any channel yet. Invite it with /invite in the channel you want to use."
              : "You are not a member of any channel.",
          );
  } catch (e) {
    destinations = step(
      "destinations",
      "Channel access",
      "fail",
      e instanceof ConnectorError && e.category === "scope_missing"
        ? "Channels cannot be listed without channels:read or groups:read."
        : "Channels could not be listed right now.",
    );
  }

  const all = [credential, reachability, identity, scopes, destinations];
  const failed = all.filter((s) => s.status === "fail").length;
  return {
    overall: failed === 0 ? "pass" : identityOk && canPost ? "partial" : "fail",
    identity: identityOk
      ? {
          displayName: mode === "bot" ? `${who.team} (app)` : `${who.team} (as ${who.user})`,
          externalAccountId: ctx.account.externalAccountId,
        }
      : undefined,
    grantedScopes: who.scopes.length ? who.scopes : undefined,
    steps: all,
  };
}

export const slackRuntime: ConnectorRuntime = {
  provider: "slack",
  healthTest: slackHealthTest,
  async execute() {
    // Message sending is implemented in P1-049.
    throw new ConnectorError("failed_before_dispatch", "Slack execution is not available yet");
  },
};
