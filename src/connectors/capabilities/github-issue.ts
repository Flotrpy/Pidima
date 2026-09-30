import { z } from "zod";
import { boundedText } from "../text";
import type { CapabilityDefinition } from "../types";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const githubIssueArgs = z.object({
  owner: z
    .string()
    .trim()
    .regex(OWNER, "Invalid GitHub owner")
    .transform((s) => s.toLowerCase()),
  repo: z
    .string()
    .trim()
    .regex(REPO, "Invalid repository name")
    .refine((s) => s !== "." && s !== "..", "Invalid repository name")
    .transform((s) => s.toLowerCase()),
  title: boundedText(256),
  body: boundedText(60_000, { multiline: true, min: 0 }).default(""),
  labels: z
    .array(boundedText(50))
    .max(10)
    .default([])
    .transform((l) => [...new Set(l)].sort()),
});
export type GithubIssueArgs = z.infer<typeof githubIssueArgs>;

export const githubIssue: CapabilityDefinition<GithubIssueArgs> = {
  id: "github.propose_issue",
  provider: "github",
  title: "GitHub issue",
  verb: "create a GitHub issue",
  requiredScopes: ["repo"],
  argsSchema: githubIssueArgs,
  destination: (a) => `${a.owner}/${a.repo}`,
  resources: (a) => [{ kind: "github_repo", value: `${a.owner}/${a.repo}` }],
  reviewFields: (a) => [
    { label: "Repository", value: `${a.owner}/${a.repo}`, kind: "text", emphasis: true },
    { label: "Title", value: a.title, kind: "text" },
    { label: "Body", value: a.body || "(empty)", kind: "longtext" },
    ...(a.labels.length ? [{ label: "Labels", value: a.labels, kind: "list" as const }] : []),
  ],
  consequences: (a) => [
    `A new issue will be created in ${a.owner}/${a.repo}.`,
    "Everyone with access to the repository can see it, and repository members may be notified.",
  ],
  safeSummary: (a) => `Create GitHub issue in ${a.owner}/${a.repo}`,
};
