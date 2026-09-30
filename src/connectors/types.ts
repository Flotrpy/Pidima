import type { ZodType } from "zod";
import type { Capability } from "@/lib/permissions";
import type { ErrorCategory } from "./errors";

export type Provider = "github" | "slack" | "gmail";

/** A labelled fact shown on the review screen. Content is always rendered as text, never HTML. */
export type ReviewField = {
  label: string;
  value: string | string[];
  kind: "text" | "longtext" | "list";
  /** Destination and recipients are emphasised so they are never buried. */
  emphasis?: boolean;
  warning?: string;
};

export type CapabilityDefinition<Args extends Record<string, unknown> = Record<string, unknown>> = {
  id: Capability;
  provider: Provider;
  title: string;
  /** Verb phrase for "Claude wants to …". */
  verb: string;
  requiredScopes: string[];
  /** Untrusted AI input is parsed here; the parsed result is already canonical. */
  argsSchema: ZodType<Args, unknown>;
  /** Human-readable destination ("acme/platform", "#ops", "a@b.com, c@d.com"). */
  destination(args: Args): string;
  /** Resource identifiers that resource policies are matched against. */
  resources(
    args: Args,
  ): { kind: "github_repo" | "slack_channel" | "email_sender" | "email_domain"; value: string }[];
  reviewFields(args: Args): ReviewField[];
  consequences(args: Args): string[];
  /** Short summary that is safe to send over MCP and notifications (no content). */
  safeSummary(args: Args): string;
};

export type ExecutionOutcome =
  | { status: "succeeded"; providerId: string; url?: string; details?: Record<string, unknown> }
  | { status: "failed"; category: ErrorCategory; message: string }
  | { status: "unknown"; reason: string };

export type HealthStepResult = {
  id: "credential" | "reachability" | "identity" | "scopes" | "destinations";
  label: string;
  status: "pass" | "fail" | "skipped";
  detail?: string;
};

export type HealthTestResult = {
  overall: "pass" | "fail" | "partial";
  steps: HealthStepResult[];
  identity?: { displayName: string; externalAccountId: string };
  grantedScopes?: string[];
};

export type SafeFetch = (
  url: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

export type RuntimeContext = {
  account: {
    id: string;
    workspaceId: string;
    externalAccountId: string;
    displayName: string;
    grantedScopes: string[];
    metadata: Record<string, unknown>;
  };
  getAccessToken(): Promise<string>;
  fetch: SafeFetch;
};

/** Provider I/O. Registered separately from the pure capability definitions. */
export type ConnectorRuntime = {
  provider: Provider;
  healthTest(ctx: RuntimeContext): Promise<HealthTestResult>;
  execute(
    ctx: RuntimeContext,
    capability: Capability,
    args: Record<string, unknown>,
    opts: { idempotencyKey: string; proposalId: string },
  ): Promise<ExecutionOutcome>;
  /** Looks up whether an ambiguous write actually happened. Only where the provider allows it. */
  reconcile?(
    ctx: RuntimeContext,
    capability: Capability,
    args: Record<string, unknown>,
    opts: { idempotencyKey: string; proposalId: string },
  ): Promise<ExecutionOutcome | null>;
};

export type ConnectorMeta = {
  provider: Provider;
  displayName: string;
  capabilities: Capability[];
};
