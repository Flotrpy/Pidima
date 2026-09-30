import type { Capability } from "@/lib/permissions";

export type EditField = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "lines";
  hint?: string;
};

/** Which fields a reviewer can edit for each capability, and how form text maps to arguments. */
export const EDIT_SPECS: Record<Capability, EditField[]> = {
  "github.propose_issue": [
    { name: "owner", label: "Repository owner", kind: "text" },
    { name: "repo", label: "Repository name", kind: "text" },
    { name: "title", label: "Title", kind: "text" },
    { name: "body", label: "Body", kind: "textarea" },
    { name: "labels", label: "Labels", kind: "lines", hint: "One per line." },
  ],
  "slack.propose_message": [
    { name: "channel", label: "Channel ID", kind: "text" },
    { name: "text", label: "Message", kind: "textarea" },
    {
      name: "threadTs",
      label: "Reply in thread (timestamp)",
      kind: "text",
      hint: "Leave empty for a new message.",
    },
  ],
  "email.propose_message": [
    { name: "from", label: "From", kind: "text" },
    { name: "to", label: "To", kind: "lines", hint: "One address per line." },
    { name: "cc", label: "CC", kind: "lines" },
    { name: "bcc", label: "BCC", kind: "lines" },
    { name: "subject", label: "Subject", kind: "text" },
    { name: "textBody", label: "Plain-text body", kind: "textarea" },
    { name: "htmlBody", label: "HTML body (source)", kind: "textarea" },
  ],
};

export function formToArgs(
  capability: Capability,
  get: (name: string) => string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of EDIT_SPECS[capability]) {
    const raw = get(f.name) ?? "";
    if (f.kind === "lines")
      out[f.name] = raw
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);
    else if (
      raw.trim() === "" &&
      (f.name === "threadTs" || f.name === "htmlBody" || f.name === "textBody")
    )
      out[f.name] = undefined;
    else out[f.name] = raw;
  }
  return out;
}

export function argsToForm(
  capability: Capability,
  args: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of EDIT_SPECS[capability]) {
    const v = args[f.name];
    out[f.name] = Array.isArray(v) ? v.join("\n") : v === undefined || v === null ? "" : String(v);
  }
  return out;
}
