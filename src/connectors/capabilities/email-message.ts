import { z } from "zod";
import { boundedText, cleanText } from "../text";
import type { CapabilityDefinition } from "../types";

// Deliberately conservative: rejects display names, quotes, comments and anything with whitespace,
// which also removes header-injection vectors (CR/LF can never match).
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const emailAddress = z
  .string()
  .trim()
  .max(254)
  .regex(ADDRESS, "Invalid email address")
  .transform((s) => {
    const at = s.lastIndexOf("@");
    return `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
  });

const addressList = (max: number) =>
  z
    .array(emailAddress)
    .max(max)
    .default([])
    .transform((l) => [...new Set(l)]);

export const MAX_RECIPIENTS = 50;

export const emailMessageArgs = z
  .object({
    from: emailAddress,
    to: addressList(20).pipe(z.array(z.string()).min(1, "At least one recipient is required")),
    cc: addressList(20),
    bcc: addressList(20),
    subject: boundedText(200),
    textBody: z.string().transform(cleanText).pipe(z.string().max(100_000)).optional(),
    htmlBody: z.string().transform(cleanText).pipe(z.string().max(200_000)).optional(),
  })
  .refine((v) => (v.textBody?.trim() ?? "") !== "" || (v.htmlBody?.trim() ?? "") !== "", {
    message: "Provide a text or HTML body",
    path: ["textBody"],
  })
  .refine((v) => new Set([...v.to, ...v.cc, ...v.bcc]).size <= MAX_RECIPIENTS, {
    message: `At most ${MAX_RECIPIENTS} distinct recipients`,
    path: ["to"],
  });
export type EmailMessageArgs = z.infer<typeof emailMessageArgs>;

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

export const emailMessage: CapabilityDefinition<EmailMessageArgs> = {
  id: "email.propose_message",
  provider: "gmail",
  title: "Email",
  verb: "send an email",
  requiredScopes: ["https://www.googleapis.com/auth/gmail.send"],
  argsSchema: emailMessageArgs,
  destination: (a) => [...a.to, ...a.cc, ...a.bcc].join(", "),
  resources: (a) => [
    { kind: "email_sender", value: a.from },
    ...[...new Set([...a.to, ...a.cc, ...a.bcc].map(domainOf))].map((d) => ({
      kind: "email_domain" as const,
      value: d,
    })),
  ],
  reviewFields: (a) => [
    { label: "From", value: a.from, kind: "text", emphasis: true },
    { label: "To", value: a.to, kind: "list", emphasis: true },
    ...(a.cc.length ? [{ label: "CC", value: a.cc, kind: "list" as const, emphasis: true }] : []),
    ...(a.bcc.length
      ? [
          {
            label: "BCC (hidden from other recipients)",
            value: a.bcc,
            kind: "list" as const,
            emphasis: true,
          },
        ]
      : []),
    { label: "Subject", value: a.subject, kind: "text" },
    ...(a.textBody
      ? [{ label: "Plain-text body", value: a.textBody, kind: "longtext" as const }]
      : []),
    // HTML is shown as source text only; it is never rendered in the reviewer's browser.
    ...(a.htmlBody
      ? [{ label: "HTML body (source)", value: a.htmlBody, kind: "longtext" as const }]
      : []),
  ],
  consequences: (a) => [
    `An email will be sent from ${a.from} to ${new Set([...a.to, ...a.cc, ...a.bcc]).size} recipient(s).`,
    "Email cannot be recalled once accepted by the provider. Acceptance does not prove delivery or that it was read.",
  ],
  receiptFacts: (a) => [
    { label: "From", value: a.from },
    { label: "To", value: a.to.join(", ") },
    ...(a.cc.length ? [{ label: "CC", value: a.cc.join(", ") }] : []),
    ...(a.bcc.length ? [{ label: "BCC", value: a.bcc.join(", ") }] : []),
    { label: "Subject", value: a.subject },
    {
      label: "Body length",
      value: `${(a.textBody ?? "").length + (a.htmlBody ?? "").length} characters`,
    },
  ],
  safeSummary: (a) => `Send email to ${new Set([...a.to, ...a.cc, ...a.bcc]).size} recipient(s)`,
};
