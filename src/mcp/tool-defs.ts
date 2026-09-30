import { z } from "zod";
import type { Capability } from "@/lib/permissions";

const common = {
  connector_account_id: z
    .string()
    .uuid()
    .optional()
    .describe("Only needed when several accounts are connected for this service."),
  client_request_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Optional idempotency key. Retrying with the same value returns the original proposal instead of creating a duplicate.",
    ),
};

export const TOOL_DEFS: Record<
  Capability,
  { title: string; description: string; shape: z.ZodRawShape }
> = {
  "github.propose_issue": {
    title: "Propose a GitHub issue",
    description:
      "Propose creating a GitHub issue. This does NOT create the issue: it queues the exact request for a human to review, edit, approve or deny. Returns a proposal ID and a review link.",
    shape: {
      owner: z.string().describe("Repository owner (user or organization)."),
      repo: z.string().describe("Repository name."),
      title: z.string().describe("Issue title (max 256 characters)."),
      body: z.string().optional().describe("Issue body in Markdown (max 60,000 characters)."),
      labels: z.array(z.string()).optional().describe("Optional label names."),
      ...common,
    },
  },
  "slack.propose_message": {
    title: "Propose a Slack message",
    description:
      "Propose sending a Slack message. This does NOT send it: it queues the exact message for a human to review, edit, approve or deny. Returns a proposal ID and a review link.",
    shape: {
      channel: z
        .string()
        .describe(
          "Slack channel name such as #ops (the connected app or account must be a member), or a channel ID such as C0123456789.",
        ),
      text: z.string().describe("Message text (max 4,000 characters)."),
      thread_ts: z.string().optional().describe("Timestamp of the thread to reply in."),
      ...common,
    },
  },
  "email.propose_message": {
    title: "Propose an email",
    description:
      "Propose sending an email. This does NOT send it: it queues the exact message and recipients for a human to review, edit, approve or deny. Returns a proposal ID and a review link.",
    shape: {
      from: z.string().describe("Sender address. Must be an identity connected to the workspace."),
      to: z.array(z.string()).describe("Recipient addresses."),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string().describe("Subject line (single line)."),
      text_body: z.string().optional().describe("Plain-text body."),
      html_body: z
        .string()
        .optional()
        .describe("HTML body. Shown to reviewers as source, never rendered."),
      ...common,
    },
  },
};

/** Maps the snake_case tool input to the internal argument names. */
export function toProposalArgs(
  capability: Capability,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { connector_account_id: _c, client_request_id: _r, ...rest } = input;
  void _c;
  void _r;
  if (capability === "slack.propose_message") {
    const { thread_ts, ...others } = rest;
    return { ...others, threadTs: thread_ts };
  }
  if (capability === "email.propose_message") {
    const { text_body, html_body, ...others } = rest;
    return { ...others, textBody: text_body, htmlBody: html_body };
  }
  return rest;
}
