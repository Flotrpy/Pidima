import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  connectorAccounts,
  mcpClients,
  mcpGrants,
  proposalVersions,
  proposals,
  users,
} from "@/db/schema";
import { insertVersion } from "@/server/versions";
import {
  evaluateForProposal,
  evaluateForPropose,
  listCapabilityPolicies,
  listResourceRules,
  removeResourceRule,
  setResourceRule,
  updateCapabilityPolicy,
} from "@/server/policy";
import {
  acceptInvitation,
  changeMemberRole,
  createWorkspace,
  inviteMember,
} from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function join(ownerId: string, wsId: string, role: "approver" | "member" | "viewer") {
  const email = `j${Math.random()}@example.test`;
  const id = await user(email);
  const { url } = await inviteMember(ownerId, wsId, email, role);
  await acceptInvitation(id, url.split("/invite/")[1]!);
  return id;
}

async function setup(provider: "github" | "gmail" = "github", scopes = ["repo"]) {
  const owner = await user(`p${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "Policy");
  const [conn] = await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId: ws.id,
      provider,
      externalAccountId: `${Math.random()}`,
      displayName: "acct",
      connectedByUserId: owner,
      grantedScopes: scopes,
    })
    .returning();
  const [client] = await getDb()
    .insert(mcpClients)
    .values({
      clientId: `mcp_${Math.random()}`,
      name: "Claude",
      redirectUris: ["https://claude.ai/cb"],
    })
    .returning();
  const [grant] = await getDb()
    .insert(mcpGrants)
    .values({
      mcpClientId: client!.id,
      userId: owner,
      workspaceId: ws.id,
      scopes: ["proposals:create"],
    })
    .returning();
  return { owner, ws, conn: conn!, grant: grant! };
}

const issue = { owner: "acme", repo: "platform", title: "t", body: "b", labels: [] };
const propose = (s: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown> = issue) =>
  evaluateForPropose({
    workspaceId: s.ws.id,
    capability: "github.propose_issue",
    connectorAccountId: s.conn.id,
    args,
    grantId: s.grant.id,
  });

describe("policy evaluation against the database", () => {
  it("denies by default, then allows once the owner enables the capability", async () => {
    const s = await setup();
    expect((await propose(s)).reasons.map((r) => r.code)).toContain("capability_disabled");
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    expect((await propose(s)).allowed).toBe(true);
  });

  it("re-evaluates against live connector, grant and role state", async () => {
    const s = await setup();
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    expect((await propose(s)).allowed).toBe(true);
    await getDb()
      .update(connectorAccounts)
      .set({ status: "revoked" })
      .where(eq(connectorAccounts.id, s.conn.id));
    expect((await propose(s)).reasons.map((r) => r.code)).toContain("connector_inactive");
    await getDb()
      .update(connectorAccounts)
      .set({ status: "active" })
      .where(eq(connectorAccounts.id, s.conn.id));
    await getDb()
      .update(mcpGrants)
      .set({ revokedAt: new Date() })
      .where(eq(mcpGrants.id, s.grant.id));
    expect((await propose(s)).reasons.map((r) => r.code)).toContain("grant_invalid");
  });

  it("applies repository allowlists from owner-managed rules", async () => {
    const s = await setup();
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    const rule = await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "Acme/Other",
      effect: "allow",
    });
    expect((await propose(s)).reasons.map((r) => r.code)).toContain("resource_not_allowed");
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/*",
      effect: "allow",
    });
    expect((await propose(s)).allowed).toBe(true);
    await removeResourceRule(s.owner, s.ws.id, rule.id);
    expect((await listResourceRules(s.owner, s.ws.id)).map((r) => r.value)).toEqual(["acme/*"]);
  });

  it("enforces recipient-domain policy with an external-domain warning", async () => {
    const s = await setup("gmail", ["https://www.googleapis.com/auth/gmail.send"]);
    await updateCapabilityPolicy(s.owner, s.ws.id, "email.propose_message", { enabled: true });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "email_domain",
      value: "blocked.test",
      effect: "block",
    });
    const run = (to: string) =>
      evaluateForPropose({
        workspaceId: s.ws.id,
        capability: "email.propose_message",
        connectorAccountId: s.conn.id,
        grantId: s.grant.id,
        args: { from: "me@acme.com", to: [to], cc: [], bcc: [], subject: "s", textBody: "b" },
      });
    expect((await run("x@blocked.test")).reasons.map((r) => r.code)).toEqual(["domain_blocked"]);
    const ext = await run("x@elsewhere.test");
    expect(ext.allowed).toBe(true);
    expect(ext.warnings.map((w) => w.code)).toEqual(["external_domain"]);
    expect((await run("y@acme.com")).warnings).toEqual([]);
  });

  it("checks deciders and separation of duties, then re-checks the approver at execution", async () => {
    const s = await setup();
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    const approver = await join(s.owner, s.ws.id, "approver");
    const member = await join(s.owner, s.ws.id, "member");
    const [p] = await getDb()
      .insert(proposals)
      .values({
        workspaceId: s.ws.id,
        capability: "github.propose_issue",
        connectorAccountId: s.conn.id,
        mcpGrantId: s.grant.id,
        initiatedByUserId: s.owner,
        clientLabel: "Claude",
        correlationId: "c",
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    const v = await insertVersion(getDb(), {
      proposal: p!,
      version: 1,
      args: issue,
      author: { type: "ai" },
    });

    expect((await evaluateForProposal("decide", p!, v.args, approver)).allowed).toBe(true);
    expect(
      (await evaluateForProposal("decide", p!, v.args, member)).reasons.map((r) => r.code),
    ).toContain("not_an_approver");
    expect(
      (await evaluateForProposal("decide", p!, v.args, s.owner)).reasons.map((r) => r.code),
    ).toContain("self_approval");
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", {
      allowSelfApproval: true,
    });
    expect((await evaluateForProposal("decide", p!, v.args, s.owner)).allowed).toBe(true);

    await getDb().insert(approvalDecisions).values({
      proposalId: p!.id,
      proposalVersionId: v.id,
      decision: "approve",
      decidedByUserId: approver,
    });
    expect((await evaluateForProposal("execute", p!, v.args)).allowed).toBe(true);
    await changeMemberRole(s.owner, s.ws.id, approver, "viewer");
    expect((await evaluateForProposal("execute", p!, v.args)).reasons.map((r) => r.code)).toContain(
      "approver_lost_access",
    );
  });
});

describe("policy management", () => {
  it("is owner-only and validated", async () => {
    const s = await setup();
    const member = await join(s.owner, s.ws.id, "member");
    await expect(
      updateCapabilityPolicy(member, s.ws.id, "github.propose_issue", { enabled: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setResourceRule(member, s.ws.id, { kind: "github_repo", value: "a/b", effect: "allow" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(listCapabilityPolicies(member, s.ws.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      setResourceRule(s.owner, s.ws.id, {
        kind: "github_repo",
        value: "not valid",
        effect: "allow",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      setResourceRule(s.owner, s.ws.id, {
        kind: "slack_channel",
        value: "C0123456789",
        effect: "warn",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("clamps expiry into safe limits and rejects non-integers", async () => {
    const s = await setup();
    expect(
      (await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { expirySeconds: 5 }))
        .expirySeconds,
    ).toBe(300);
    expect(
      (
        await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", {
          expirySeconds: 10 ** 9,
        })
      ).expirySeconds,
    ).toBe(7 * 24 * 3600);
    await expect(
      updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { expirySeconds: 1.5 }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("will not attach a rule to another workspace's connector", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      setResourceRule(a.owner, a.ws.id, {
        kind: "github_repo",
        value: "a/b",
        effect: "allow",
        connectorAccountId: b.conn.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      removeResourceRule(a.owner, a.ws.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
