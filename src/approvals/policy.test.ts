import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  normalizeRuleValue,
  ruleMatches,
  scopesSatisfied,
  clampExpiry,
  type PolicyFacts,
} from "./policy";

const W = "w1";
const future = new Date(Date.now() + 3600_000);
const base = (over: Partial<PolicyFacts> = {}): PolicyFacts => ({
  stage: "propose",
  capability: "github.propose_issue",
  requiredScopes: ["repo"],
  capabilityPolicy: { enabled: true, allowSelfApproval: false, expirySeconds: 3600 },
  connector: { id: "c1", status: "active", grantedScopes: ["repo"], workspaceId: W },
  workspaceId: W,
  resources: [{ kind: "github_repo", value: "acme/platform" }],
  rules: [],
  grant: { scopes: ["proposals:create"], revoked: false, workspaceId: W },
  actor: { userId: "u1", role: "member", approvalCapabilities: null },
  proposal: { initiatedByUserId: "u1", expiresAt: future, state: "PENDING_APPROVAL" },
  ...over,
});
const codes = (f: PolicyFacts) => evaluatePolicy(f).reasons.map((r) => r.code);

describe("effective policy: propose", () => {
  it("allows when every constraint is satisfied", () => {
    expect(evaluatePolicy(base())).toMatchObject({ allowed: true, reasons: [] });
  });

  it("denies by default when no policy exists or it is disabled", () => {
    expect(codes(base({ capabilityPolicy: null }))).toContain("capability_disabled");
    expect(
      codes(
        base({
          capabilityPolicy: { enabled: false, allowSelfApproval: false, expirySeconds: 3600 },
        }),
      ),
    ).toContain("capability_disabled");
  });

  it("requires an active connector in the same workspace with the provider scopes", () => {
    expect(codes(base({ connector: null }))).toContain("connector_missing");
    expect(
      codes(
        base({
          connector: { id: "c1", status: "active", grantedScopes: ["repo"], workspaceId: "other" },
        }),
      ),
    ).toContain("connector_missing");
    expect(
      codes(
        base({
          connector: { id: "c1", status: "needs_reauth", grantedScopes: ["repo"], workspaceId: W },
        }),
      ),
    ).toContain("connector_inactive");
    expect(
      codes(
        base({
          connector: { id: "c1", status: "active", grantedScopes: ["read:user"], workspaceId: W },
        }),
      ),
    ).toContain("scope_missing");
  });

  it("requires a valid, workspace-bound MCP grant with the create scope", () => {
    expect(codes(base({ grant: null }))).toContain("grant_invalid");
    expect(
      codes(base({ grant: { scopes: ["proposals:create"], revoked: true, workspaceId: W } })),
    ).toContain("grant_invalid");
    expect(
      codes(
        base({ grant: { scopes: ["proposals:create"], revoked: false, workspaceId: "other" } }),
      ),
    ).toContain("grant_invalid");
    expect(
      codes(base({ grant: { scopes: ["proposals:read"], revoked: false, workspaceId: W } })),
    ).toContain("grant_scope");
  });

  it("denies when the authorizing user lost the right to connect AI clients", () => {
    expect(
      codes(base({ actor: { userId: "u1", role: "viewer", approvalCapabilities: null } })),
    ).toContain("actor_forbidden");
  });
});

describe("effective policy: resources", () => {
  const rule = (
    kind: any,
    value: string,
    effect: any,
    connectorAccountId: string | null = null,
  ) => ({ kind, value, effect, connectorAccountId });

  it("treats an allowlist as exclusive once it exists", () => {
    const f = base({ rules: [rule("github_repo", "acme/platform", "allow")] });
    expect(evaluatePolicy(f).allowed).toBe(true);
    expect(codes({ ...f, resources: [{ kind: "github_repo", value: "acme/secrets" }] })).toContain(
      "resource_not_allowed",
    );
  });

  it("supports owner wildcards and is case-insensitive", () => {
    const f = base({
      rules: [rule("github_repo", "ACME/*", "allow")],
      resources: [{ kind: "github_repo", value: "acme/anything" }],
    });
    expect(evaluatePolicy(f).allowed).toBe(true);
    expect(
      codes({ ...f, resources: [{ kind: "github_repo", value: "other/anything" }] }),
    ).toContain("resource_not_allowed");
  });

  it("blocks override allows", () => {
    const f = base({
      rules: [rule("github_repo", "acme/*", "allow"), rule("github_repo", "acme/secrets", "block")],
      resources: [{ kind: "github_repo", value: "acme/secrets" }],
    });
    expect(codes(f)).toContain("resource_blocked");
  });

  it("scopes a rule to one connector account when set", () => {
    const f = base({ rules: [rule("github_repo", "other/repo", "allow", "some-other-connector")] });
    expect(evaluatePolicy(f).allowed).toBe(true); // rule does not apply to c1, so no allowlist is active
    const g = base({ rules: [rule("github_repo", "other/repo", "allow", "c1")] });
    expect(codes(g)).toContain("resource_not_allowed");
  });

  it("restricts Slack channels and email senders with allowlists", () => {
    const slack = base({
      capability: "slack.propose_message",
      resources: [{ kind: "slack_channel", value: "C0123456789" }],
      rules: [rule("slack_channel", "C0000000001", "allow")],
    });
    expect(codes(slack)).toContain("resource_not_allowed");
    const mail = base({
      capability: "email.propose_message",
      resources: [{ kind: "email_sender", value: "me@acme.com" }],
      rules: [rule("email_sender", "ops@acme.com", "allow")],
    });
    expect(codes(mail)).toContain("resource_not_allowed");
  });

  it("blocks, warns and flags external recipient domains", () => {
    const resources = [
      { kind: "email_domain" as const, value: "evil.test" },
      { kind: "email_domain" as const, value: "partner.io" },
      { kind: "email_domain" as const, value: "acme.com" },
      { kind: "email_domain" as const, value: "trusted.org" },
    ];
    const rules = [
      rule("email_domain", "evil.test", "block"),
      rule("email_domain", "partner.io", "warn"),
      rule("email_domain", "trusted.org", "allow"),
    ];
    const d = evaluatePolicy(
      base({ capability: "email.propose_message", resources, rules, senderDomain: "acme.com" }),
    );
    expect(d.reasons.map((r) => r.code)).toEqual(["domain_blocked"]);
    expect(d.warnings.map((w) => w.code)).toEqual(["domain_warn"]);
    const ok = evaluatePolicy(
      base({
        capability: "email.propose_message",
        resources: [{ kind: "email_domain", value: "random.net" }],
        senderDomain: "acme.com",
      }),
    );
    expect(ok.allowed).toBe(true);
    expect(ok.warnings.map((w) => w.code)).toEqual(["external_domain"]);
  });

  it("matches wildcard subdomains for email rules", () => {
    expect(ruleMatches("email_domain", "*.evil.test", "a.evil.test")).toBe(true);
    expect(ruleMatches("email_domain", "*.evil.test", "evil.test")).toBe(true);
    expect(ruleMatches("email_domain", "*.evil.test", "notevil.test")).toBe(false);
  });
});

describe("effective policy: decide", () => {
  const decide = (over: Partial<PolicyFacts> = {}) =>
    base({
      stage: "decide",
      actor: { userId: "u2", role: "approver", approvalCapabilities: null },
      ...over,
    });

  it("lets an approver decide", () => {
    expect(evaluatePolicy(decide()).allowed).toBe(true);
  });

  it("denies members and viewers, and approvers outside their scope", () => {
    expect(
      codes(decide({ actor: { userId: "u2", role: "member", approvalCapabilities: null } })),
    ).toContain("not_an_approver");
    expect(
      codes(decide({ actor: { userId: "u2", role: "viewer", approvalCapabilities: null } })),
    ).toContain("not_an_approver");
    expect(
      codes(
        decide({
          actor: {
            userId: "u2",
            role: "approver",
            approvalCapabilities: ["slack.propose_message"],
          },
        }),
      ),
    ).toContain("not_an_approver");
  });

  it("enforces separation of duties unless the workspace allows self-approval", () => {
    const self = { userId: "u1", role: "owner" as const, approvalCapabilities: null };
    expect(codes(decide({ actor: self }))).toContain("self_approval");
    expect(
      evaluatePolicy(
        decide({
          actor: self,
          capabilityPolicy: { enabled: true, allowSelfApproval: true, expirySeconds: 3600 },
        }),
      ).allowed,
    ).toBe(true);
  });

  it("does not treat an unknown requester as self", () => {
    expect(
      evaluatePolicy(
        decide({
          proposal: { initiatedByUserId: null, expiresAt: future, state: "PENDING_APPROVAL" },
        }),
      ).allowed,
    ).toBe(true);
  });

  it("rejects expired proposals", () => {
    expect(
      codes(
        decide({
          proposal: {
            initiatedByUserId: null,
            expiresAt: new Date(Date.now() - 1),
            state: "PENDING_APPROVAL",
          },
        }),
      ),
    ).toContain("proposal_expired");
  });
});

describe("effective policy: execute", () => {
  const exec = (over: Partial<PolicyFacts> = {}) =>
    base({
      stage: "execute",
      decider: { userId: "u2", role: "approver", approvalCapabilities: null },
      ...over,
    });

  it("re-checks everything at dispatch time", () => {
    expect(evaluatePolicy(exec()).allowed).toBe(true);
    expect(
      codes(
        exec({
          capabilityPolicy: { enabled: false, allowSelfApproval: false, expirySeconds: 3600 },
        }),
      ),
    ).toContain("capability_disabled");
    expect(
      codes(
        exec({
          connector: { id: "c1", status: "revoked", grantedScopes: ["repo"], workspaceId: W },
        }),
      ),
    ).toContain("connector_inactive");
    expect(
      codes(
        exec({
          rules: [
            {
              kind: "github_repo",
              value: "acme/platform",
              effect: "block",
              connectorAccountId: null,
            },
          ],
        }),
      ),
    ).toContain("resource_blocked");
    expect(
      codes(exec({ decider: { userId: "u2", role: "viewer", approvalCapabilities: null } })),
    ).toContain("approver_lost_access");
    expect(codes(exec({ decider: null }))).toContain("approver_lost_access");
    expect(
      codes(
        exec({
          proposal: {
            initiatedByUserId: null,
            expiresAt: new Date(Date.now() - 1),
            state: "APPROVED",
          },
        }),
      ),
    ).toContain("proposal_expired");
  });
});

describe("helpers", () => {
  it("clamps expiry into safe limits", () => {
    expect(clampExpiry(10)).toBe(300);
    expect(clampExpiry(10 ** 9)).toBe(7 * 24 * 3600);
    expect(clampExpiry(undefined)).toBe(3600);
    expect(clampExpiry(1800)).toBe(1800);
  });

  it("lets repo scope cover public_repo but not the reverse", () => {
    expect(scopesSatisfied(["public_repo"], ["repo"])).toBe(true);
    expect(scopesSatisfied(["repo"], ["public_repo"])).toBe(false);
  });

  it("normalizes and validates rule values per kind", () => {
    expect(normalizeRuleValue("github_repo", " Acme/Platform ")).toBe("acme/platform");
    expect(normalizeRuleValue("github_repo", "acme/*")).toBe("acme/*");
    expect(normalizeRuleValue("github_repo", "acme")).toBeNull();
    expect(normalizeRuleValue("slack_channel", "c0123456789")).toBe("C0123456789");
    expect(normalizeRuleValue("slack_channel", "#general")).toBeNull();
    expect(normalizeRuleValue("email_domain", "*.Example.com")).toBe("*.example.com");
    expect(normalizeRuleValue("email_sender", "not an email")).toBeNull();
  });
});
