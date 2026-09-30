import { ConnectorError } from "../errors";
import type {
  ConnectorRuntime,
  HealthStepResult,
  HealthTestResult,
  ProposalValidation,
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

const CHANNEL_ID = /^[CGD][A-Z0-9]{8,}$/;

/** Resolves "#ops" to a channel ID among channels this connection can see. No enumeration on failure. */
export async function slackResolveArgs(
  ctx: RuntimeContext,
  args: Record<string, unknown>,
): Promise<
  | { status: "ok"; args: Record<string, unknown> }
  | {
      status: "rejected";
      category: "destination_inaccessible" | "auth_expired" | "provider_unavailable";
      message: string;
    }
> {
  const raw = String(args.channel ?? "");
  if (CHANNEL_ID.test(raw)) return { status: "ok", args };
  const name = raw.replace(/^#/, "").toLowerCase();
  try {
    const client = new SlackClient(ctx.fetch, await ctx.getAccessToken());
    const { channels } = await client.listChannels();
    const matches = channels.filter(
      (c) => c.name.toLowerCase() === name && !c.isArchived && c.isMember,
    );
    if (matches.length === 1) return { status: "ok", args: { ...args, channel: matches[0]!.id } };
    return {
      status: "rejected",
      category: "destination_inaccessible",
      message: `No channel named #${name} is available to this connection. Invite the app to the channel, or use the channel's ID.`,
    };
  } catch (e) {
    if (e instanceof ConnectorError && e.category === "auth_expired")
      return {
        status: "rejected",
        category: "auth_expired",
        message: "The Slack connection needs to be reconnected.",
      };
    return {
      status: "rejected",
      category: "provider_unavailable",
      message: `Slack could not resolve #${name} right now. Try again, or use the channel's ID.`,
    };
  }
}

/** Read-only checks for a proposed message: real channel, not archived, and this sender can post there. */
export async function slackValidateProposal(
  ctx: RuntimeContext,
  args: Record<string, unknown>,
): Promise<ProposalValidation> {
  let token: string;
  try {
    token = await ctx.getAccessToken();
  } catch {
    return { status: "unverified", reason: "credential_unavailable" };
  }
  const channelId = String(args.channel);
  try {
    const ch = await new SlackClient(ctx.fetch, token).getChannel(channelId);
    if (ch.isArchived)
      return {
        status: "rejected",
        category: "destination_inaccessible",
        message: `#${ch.name} is archived and cannot receive messages.`,
      };
    if (!ch.isMember) {
      const who = ctx.account.metadata.senderMode === "user" ? "You are" : "The app is";
      return {
        status: "rejected",
        category: "destination_inaccessible",
        message: `${who} not a member of #${ch.name}. ${ctx.account.metadata.senderMode === "user" ? "Join the channel first." : "Invite the app with /invite in that channel."}`,
      };
    }
    return {
      status: "ok",
      display: {
        channelName: `${ch.isPrivate ? "🔒 " : "#"}${ch.name}`,
        channelPrivacy: ch.isPrivate ? "private" : "public",
        workspace: String(ctx.account.metadata.teamName ?? ""),
      },
    };
  } catch (e) {
    if (e instanceof ConnectorError) {
      if (e.category === "destination_inaccessible")
        return {
          status: "rejected",
          category: e.category,
          message: "That Slack channel was not found, or this connection cannot see it.",
        };
      if (e.category === "auth_expired")
        return {
          status: "rejected",
          category: e.category,
          message: "The Slack connection needs to be reconnected.",
        };
      return { status: "unverified", reason: e.category };
    }
    return { status: "unverified", reason: "unexpected_error" };
  }
}

export const slackRuntime: ConnectorRuntime = {
  provider: "slack",
  healthTest: slackHealthTest,
  resolveArgs: (ctx, _capability, args) => slackResolveArgs(ctx, args),
  validateProposal: (ctx, _capability, args) => slackValidateProposal(ctx, args),
  async execute() {
    // Message sending is implemented in P1-049.
    throw new ConnectorError("failed_before_dispatch", "Slack execution is not available yet");
  },
};
