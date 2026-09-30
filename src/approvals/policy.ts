import { canDecide, can, type Capability, type Role } from "@/lib/permissions";

export type Stage = "propose" | "decide" | "execute";
export type ResourceKind = "github_repo" | "slack_channel" | "email_sender" | "email_domain";
export type Effect = "allow" | "warn" | "block";

export type ResourceRule = {
  kind: ResourceKind;
  value: string;
  effect: Effect;
  connectorAccountId: string | null;
};
export type Resource = { kind: ResourceKind; value: string };

export type PolicyFacts = {
  stage: Stage;
  capability: Capability;
  requiredScopes: string[];
  capabilityPolicy: { enabled: boolean; allowSelfApproval: boolean; expirySeconds: number } | null;
  connector: {
    id: string;
    status: "active" | "needs_reauth" | "revoked" | "disconnected";
    grantedScopes: string[];
    workspaceId: string;
  } | null;
  workspaceId: string;
  resources: Resource[];
  rules: ResourceRule[];
  /** Propose: the MCP grant. */
  grant?: { scopes: string[]; revoked: boolean; workspaceId: string } | null;
  /** The human acting (propose: the grant's user; decide: the approver). */
  actor?: { userId: string; role: Role; approvalCapabilities: Capability[] | null } | null;
  proposal?: { initiatedByUserId: string | null; expiresAt: Date; state: string } | null;
  /** Execute: the person who approved, re-checked at dispatch time. */
  decider?: { userId: string; role: Role; approvalCapabilities: Capability[] | null } | null;
  senderDomain?: string | null;
  now?: Date;
};

export type Reason = { code: string; message: string };
export type Warning = { code: string; message: string; resource?: string };
export type PolicyDecision = {
  allowed: boolean;
  reasons: Reason[];
  warnings: Warning[];
  expirySeconds: number;
};

export const MIN_EXPIRY_SECONDS = 300;
export const MAX_EXPIRY_SECONDS = 7 * 24 * 3600;
export const DEFAULT_EXPIRY_SECONDS = 3600;

export const clampExpiry = (s: number | undefined | null) =>
  Math.min(
    MAX_EXPIRY_SECONDS,
    Math.max(
      MIN_EXPIRY_SECONDS,
      Number.isFinite(s as number) ? (s as number) : DEFAULT_EXPIRY_SECONDS,
    ),
  );

/** A provider grant of `repo` also covers `public_repo`. */
const SCOPE_COVERS: Record<string, string[]> = { public_repo: ["repo"] };
export const scopesSatisfied = (required: string[], granted: string[]) =>
  required.every(
    (r) => granted.includes(r) || (SCOPE_COVERS[r] ?? []).some((c) => granted.includes(c)),
  );

/** Exact match (case-insensitive) or a trailing wildcard segment such as `acme/*`. */
export function ruleMatches(kind: ResourceKind, ruleValue: string, value: string): boolean {
  const r = ruleValue.toLowerCase();
  const v = value.toLowerCase();
  if (kind === "github_repo" && r.endsWith("/*")) return v.startsWith(r.slice(0, -1));
  if (kind === "email_domain" && r.startsWith("*."))
    return v === r.slice(2) || v.endsWith(r.slice(1));
  return r === v;
}

export function evaluatePolicy(f: PolicyFacts): PolicyDecision {
  const reasons: Reason[] = [];
  const warnings: Warning[] = [];
  const deny = (code: string, message: string) => reasons.push({ code, message });
  const now = f.now ?? new Date();
  const expirySeconds = clampExpiry(f.capabilityPolicy?.expirySeconds);

  // --- Default deny: the capability must be explicitly enabled in this workspace.
  if (!f.capabilityPolicy || !f.capabilityPolicy.enabled)
    deny("capability_disabled", "This type of action is not enabled for the workspace.");

  // --- Connector: exists in this workspace, active, and actually holds the needed provider scopes.
  if (!f.connector || f.connector.workspaceId !== f.workspaceId) {
    deny("connector_missing", "The connected account was not found in this workspace.");
  } else {
    if (f.connector.status !== "active")
      deny("connector_inactive", "The connected account needs to be reconnected.");
    if (!scopesSatisfied(f.requiredScopes, f.connector.grantedScopes))
      deny("scope_missing", "The connected account lacks a required provider permission.");
  }

  // --- Stage-specific identity checks.
  if (f.stage === "propose") {
    if (!f.grant || f.grant.revoked || f.grant.workspaceId !== f.workspaceId)
      deny("grant_invalid", "The AI client authorization is not valid for this workspace.");
    else if (!f.grant.scopes.includes("proposals:create"))
      deny("grant_scope", "The AI client was not authorized to propose actions.");
    if (!f.actor || !can(f.actor.role, "clients.connect"))
      deny("actor_forbidden", "The authorizing user can no longer connect AI clients.");
  }

  if (f.stage === "decide") {
    if (!f.actor) deny("actor_missing", "You are not a member of this workspace.");
    else {
      if (!canDecide(f.actor.role, f.actor.approvalCapabilities, f.capability))
        deny("not_an_approver", "You are not allowed to decide this type of action.");
      if (
        f.proposal?.initiatedByUserId &&
        f.proposal.initiatedByUserId === f.actor.userId &&
        !f.capabilityPolicy?.allowSelfApproval
      ) {
        deny(
          "self_approval",
          "Workspace policy requires someone other than the requester to approve this action.",
        );
      }
    }
  }

  if (f.stage === "decide" || f.stage === "execute") {
    if (!f.proposal) deny("proposal_missing", "Proposal not found.");
    else if (f.proposal.expiresAt.getTime() <= now.getTime())
      deny("proposal_expired", "This proposal has expired.");
  }

  if (f.stage === "execute") {
    if (!f.decider || !canDecide(f.decider.role, f.decider.approvalCapabilities, f.capability))
      deny(
        "approver_lost_access",
        "The person who approved this no longer has permission to approve it.",
      );
  }

  // --- Resource policies (repos, channels, senders, recipient domains).
  const applicable = f.rules.filter(
    (r) => r.connectorAccountId === null || r.connectorAccountId === f.connector?.id,
  );
  for (const kind of ["github_repo", "slack_channel", "email_sender"] as const) {
    const kindRules = applicable.filter((r) => r.kind === kind);
    const values = f.resources.filter((x) => x.kind === kind);
    const allow = kindRules.filter((r) => r.effect === "allow");
    for (const res of values) {
      if (kindRules.some((r) => r.effect === "block" && ruleMatches(kind, r.value, res.value)))
        deny("resource_blocked", `${res.value} is blocked by workspace policy.`);
      // An allowlist, once it exists, is exclusive.
      else if (allow.length > 0 && !allow.some((r) => ruleMatches(kind, r.value, res.value)))
        deny("resource_not_allowed", `${res.value} is not in the workspace's allowed list.`);
    }
  }

  const domainRules = applicable.filter((r) => r.kind === "email_domain");
  for (const res of f.resources.filter((x) => x.kind === "email_domain")) {
    const match = domainRules.filter((r) => ruleMatches("email_domain", r.value, res.value));
    if (match.some((r) => r.effect === "block"))
      deny("domain_blocked", `Recipients at ${res.value} are blocked by workspace policy.`);
    else if (match.some((r) => r.effect === "warn"))
      warnings.push({
        code: "domain_warn",
        message: `Recipients at ${res.value} are flagged by workspace policy.`,
        resource: res.value,
      });
    else if (match.some((r) => r.effect === "allow")) continue;
    else if (f.senderDomain && res.value.toLowerCase() !== f.senderDomain.toLowerCase()) {
      warnings.push({
        code: "external_domain",
        message: `${res.value} is outside your organization's domain.`,
        resource: res.value,
      });
    }
  }

  return { allowed: reasons.length === 0, reasons, warnings, expirySeconds };
}

export const RULE_FORMATS: Record<ResourceKind, RegExp> = {
  github_repo: /^[a-z0-9](?:[a-z0-9-]{0,38})\/(?:[a-z0-9._-]{1,100}|\*)$/,
  slack_channel: /^[CGD][A-Z0-9]{8,}$/,
  email_sender: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/,
  email_domain: /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/,
};

export function normalizeRuleValue(kind: ResourceKind, value: string): string | null {
  const v = kind === "slack_channel" ? value.trim().toUpperCase() : value.trim().toLowerCase();
  return RULE_FORMATS[kind].test(v) ? v : null;
}
