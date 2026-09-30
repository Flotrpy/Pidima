import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { isCapability } from "@/lib/permissions";
import { connectAccount } from "@/server/connectors";
import { DecisionError, decideProposal } from "@/server/decisions";
import { getProposalDetail } from "@/server/inbox";
import { listRepoChoices } from "@/server/github-repos";
import {
  evaluateForProposal,
  removeResourceRule,
  setResourceRule,
  updateCapabilityPolicy,
} from "@/server/policy";
import { createProposal, ProposalError, type Principal } from "@/server/proposals";
import { getLatestArgs } from "@/server/versions";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGithub } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup() {
  const fake = fakeGithub({
    repos: [
      { owner: "acme", name: "platform" },
      { owner: "acme", name: "secrets" },
    ],
  });
  setTransportOverride("github", fake.sf);
  const email = `pe${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Enforce");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: u!.id,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: fake.token },
  });
  await updateCapabilityPolicy(u!.id, ws.id, "github.propose_issue", { enabled: true });
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
      userId: u!.id,
      workspaceId: ws.id,
      scopes: ["proposals:create"],
    })
    .returning();
  const aemail = `ap${Math.random()}@example.test`;
  await signInAs(aemail);
  const [a] = await getDb().select().from(users).where(eq(users.email, aemail));
  const { url } = await inviteMember(u!.id, ws.id, aemail, "approver");
  await acceptInvitation(a!.id, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: u!.id,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const propose = (repo: string) =>
    createProposal({
      principal,
      capability: "github.propose_issue",
      args: { owner: "acme", repo, title: "T", body: "B" },
    });
  return { owner: u!.id, approver: a!.id, ws, c, propose, fake };
}

describe("repository restrictions apply at every stage", () => {
  it("blocks at proposal time", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/platform",
      effect: "allow",
    });
    const err = await s.propose("secrets").catch((e) => e);
    expect(err).toBeInstanceOf(ProposalError);
    expect(err.code).toBe("policy_denied");
    expect((await s.propose("platform")).state).toBe("PENDING_APPROVAL");
  });

  it("re-applies a rule added AFTER the proposal was created, on the review screen, at approval, and at execution", async () => {
    const s = await setup();
    const p = await s.propose("secrets");
    expect((await getProposalDetail(s.approver, s.ws.id, p.proposalId)).blockers).toEqual([]);

    const rule = await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/secrets",
      effect: "block",
    });

    const detail = await getProposalDetail(s.approver, s.ws.id, p.proposalId);
    expect(detail.blockers.map((b) => b.code)).toContain("resource_blocked");
    await expect(
      decideProposal({
        actorId: s.approver,
        workspaceId: s.ws.id,
        proposalId: p.proposalId,
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(DecisionError);

    // Even if a proposal was approved before the rule, the executor's pre-dispatch check refuses it.
    await removeResourceRule(s.owner, s.ws.id, rule.id);
    await decideProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: p.proposalId,
      decision: "approve",
      expectedVersion: 1,
    });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/secrets",
      effect: "block",
    });
    const [row] = await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId));
    const exec = await evaluateForProposal("execute", row!, await getLatestArgs(p.proposalId));
    expect(exec.allowed).toBe(false);
    expect(exec.reasons.map((r) => r.code)).toContain("resource_blocked");
  });

  it("is reflected in the repository picker", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/*",
      effect: "allow",
    });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/secrets",
      effect: "block",
      connectorAccountId: s.c.id,
    });
    const { repos } = await listRepoChoices(s.owner, s.c.id, 1, s.fake.sf);
    expect(Object.fromEntries(repos.map((r) => [r.fullName, r.permitted]))).toEqual({
      "acme/platform": true,
      "acme/secrets": false,
    });
  });

  it("rejects malformed rules and cross-workspace connector scoping", async () => {
    const s = await setup();
    const other = await setup();
    await expect(
      setResourceRule(s.owner, s.ws.id, {
        kind: "github_repo",
        value: "not a repo",
        effect: "allow",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      setResourceRule(s.owner, s.ws.id, {
        kind: "github_repo",
        value: "a/b",
        effect: "allow",
        connectorAccountId: other.c.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("recognises capability identifiers safely", () => {
    expect(isCapability("github.propose_issue")).toBe(true);
    expect(isCapability("github.delete_repo")).toBe(false);
    expect(isCapability(undefined)).toBe(false);
  });
});
