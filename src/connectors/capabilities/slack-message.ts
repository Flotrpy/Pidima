import { z } from "zod";
import { boundedText } from "../text";
import type { CapabilityDefinition } from "../types";

export const slackMessageArgs = z.object({
  // A channel ID, or a channel name (with or without #) that the server resolves to an ID.
  channel: z
    .string()
    .trim()
    .regex(
      /^(?:[CGD][A-Z0-9]{8,}|#?[a-z0-9][a-z0-9._-]{0,79})$/,
      "Use a channel name such as #ops, or a Slack channel ID such as C0123456789",
    ),
  text: boundedText(4000, { multiline: true }),
  threadTs: z
    .string()
    .trim()
    .regex(/^\d{10}\.\d{6}$/, "Invalid thread timestamp")
    .optional(),
});
export type SlackMessageArgs = z.infer<typeof slackMessageArgs>;

/** Text that would notify many people or specific people when posted. Shown to the reviewer as a warning. */
export function pingWarning(text: string): string | undefined {
  const broadcast = /<!(?:channel|here|everyone)(?:\|[^>]*)?>|<!subteam\^[A-Z0-9]+[^>]*>/i.test(
    text,
  );
  if (broadcast)
    return "This message would notify everyone in the channel (@channel, @here or a group).";
  if (/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/.test(text))
    return "This message mentions specific people and will notify them.";
  return undefined;
}

export const slackMessage: CapabilityDefinition<SlackMessageArgs> = {
  id: "slack.propose_message",
  provider: "slack",
  title: "Slack message",
  verb: "send a Slack message",
  requiredScopes: ["chat:write"],
  argsSchema: slackMessageArgs,
  // The channel ID is authoritative; the display name is resolved at review time from the connector.
  destination: (a) => (a.threadTs ? `${a.channel} (thread ${a.threadTs})` : a.channel),
  resources: (a) => [{ kind: "slack_channel", value: a.channel }],
  reviewFields: (a) => [
    { label: "Channel", value: a.channel, kind: "text", emphasis: true },
    ...(a.threadTs ? [{ label: "Reply in thread", value: a.threadTs, kind: "text" as const }] : []),
    { label: "Message", value: a.text, kind: "longtext", warning: pingWarning(a.text) },
  ],
  consequences: (a) => [
    a.threadTs
      ? "A reply will be posted in an existing thread."
      : "A new message will be posted to the channel.",
    "Channel members will see it and may be notified. Slack messages can be deleted, but not before people have seen them.",
  ],
  safeSummary: (a) => `Send Slack message to ${a.channel}`,
  receiptFacts: (a, display) => [
    {
      label: "Channel",
      value: display?.channelName ? `${display.channelName} (${a.channel})` : a.channel,
    },
    ...(display?.workspace ? [{ label: "Slack workspace", value: display.workspace }] : []),
    ...(a.threadTs ? [{ label: "Thread", value: a.threadTs }] : []),
    { label: "Message length", value: `${a.text.length} characters` },
  ],
};
