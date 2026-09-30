import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, mcpClients, mcpGrants, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { decideProposal } from "@/server/decisions";
import { getProposalDetail } from "@/server/inbox";
import { evaluateForProposal, setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { getLatestArgs } from "@/server/versions";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGmail } from "./fake-gmail";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup() {
  const fake = fakeGmail();
  setTransportOverride("gmail", fake.sf);
  const email = `gp${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Mail Policy");
  await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "gmail",
    externalAccountId: "1234567890",
    displayName: "maya@acme.com",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    metadata: { email: "maya@acme.com", senderAddresses: ["maya@acme.com"] },
    credentials: { accessToken: fake.access, refreshToken: "r-1" },
  });
  await updateCapabilityPolicy(owner, ws.id, "email.propose_message", { enabled: true });
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
  const aemail = `ap${Math.random()}@example.test`;
  await signInAs(aemail);
  const approver = (await getDb().select().from(users).where(eq(users.email, aemail)))[0]!.id;
  const { url } = await inviteMember(owner, ws.id, aemail, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const propose = (to: string[], extra: Record<string, unknown> = {}) =>
    createProposal({
      principal,
      capability: "email.propose_message",
      args: { from: "maya@acme.com", to, subject: "s", textBody: "b", ...extra },
    });
  return { owner, approver, ws, propose };
}
const codes = (x: { code: string }[]) => x.map((w) => w.code);

describe("recipient domain policy", () => {
  it("warns about external domains by default and stays quiet for the sender's own domain", async () => {
    const s = await setup();
    const ext = await getProposalDetail(
      s.approver,
      s.ws.id,
      (await s.propose(["x@elsewhere.com"])).proposalId,
    );
    expect(codes(ext.warnings)).toEqual(["external_domain"]);
    expect(ext.warnings[0]!.message).toMatch(/elsewhere.com is outside your organization/);
    const own = await getProposalDetail(
      s.approver,
      s.ws.id,
      (await s.propose(["x@acme.com"])).proposalId,
    );
    expect(own.warnings).toEqual([]);
  });

  it("supports warn, allow (trusted) and block rules, including *. subdomain wildcards", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "email_domain",
      value: "flagged.com",
      effect: "warn",
    });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "email_domain",
      value: "trusted.org",
      effect: "allow",
    });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "email_domain",
      value: "*.evil.test",
      effect: "block",
    });
    const w = await getProposalDetail(
      s.approver,
      s.ws.id,
      (await s.propose(["a@flagged.com"])).proposalId,
    );
    expect(codes(w.warnings)).toEqual(["domain_warn"]);
    expect(
      (
        await getProposalDetail(
          s.approver,
          s.ws.id,
          (await s.propose(["a@trusted.org"])).proposalId,
        )
      ).warnings,
    ).toEqual([]);
    const blocked = await s.propose(["a@mail.evil.test"]).catch((e) => e);
    expect(blocked.code).toBe("policy_denied");
    expect(blocked.details.reasons[0].code).toBe("domain_blocked");
  });

  it("evaluates CC and BCC domains too", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "email_domain",
      value: "evil.test",
      effect: "block",
    });
    expect((await s.propose(["a@acme.com"], { bcc: ["x@evil.test"] }).catch((e) => e)).code).toBe(
      "policy_denied",
    );
    expect((await s.propose(["a@acme.com"], { cc: ["x@evil.test"] }).catch((e) => e)).code).toBe(
      "policy_denied",
    );
  });

  it("re-applies a block added after proposing, at review, approval and execution", async () => {
    const s = await setup();
    const p = await s.propose(["a@partner.com"]);
    await setResourceRule(s.owner, s.ws.id, {
      kind: "email_domain",
      value: "partner.com",
      effect: "block",
    });
    expect(codes((await getProposalDetail(s.approver, s.ws.id, p.proposalId)).blockers)).toContain(
      "domain_blocked",
    );
    await expect(
      decideProposal({
        actorId: s.approver,
        workspaceId: s.ws.id,
        proposalId: p.proposalId,
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    const [row] = await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId));
    expect(
      codes(
        (await evaluateForProposal("execute", row!, await getLatestArgs(p.proposalId))).reasons,
      ),
    ).toContain("domain_blocked");
  });

  it("restricts sender identities with an allowlist and validates rule formats", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "email_sender",
      value: "ops@acme.com",
      effect: "allow",
    });
    expect((await s.propose(["a@acme.com"]).catch((e) => e)).details.reasons[0].code).toBe(
      "resource_not_allowed",
    );
    await expect(
      setResourceRule(s.owner, s.ws.id, {
        kind: "email_domain",
        value: "not a domain",
        effect: "warn",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      setResourceRule(s.owner, s.ws.id, { kind: "email_sender", value: "x@y.com", effect: "warn" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
