import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { DecisionError, decideProposal } from "@/server/decisions";
import { getProposalDetail } from "@/server/inbox";
import {
  evaluateForProposal,
  removeResourceRule,
  setResourceRule,
  updateCapabilityPolicy,
} from "@/server/policy";
import { ProposalError, createProposal, type Principal } from "@/server/proposals";
import { getLatestArgs } from "@/server/versions";
import { listChannelChoices } from "@/server/slack-channels";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeSlack } from "./fake-slack";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const channels = [
  { id: "C0000000001", name: "ops", is_member: true },
  { id: "C0000000002", name: "secrets", is_member: true },
];

async function setup() {
  const fake = fakeSlack({ channels });
  setTransportOverride("slack", fake.sf);
  const email = `spo${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Slack Policy");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "slack",
    externalAccountId: "T0123ABCDE:bot",
    displayName: "Acme (app)",
    grantedScopes: ["chat:write", "channels:read", "groups:read"],
    metadata: { senderMode: "bot", teamId: "T0123ABCDE", teamName: "Acme" },
    credentials: { accessToken: fake.botToken },
  });
  await updateCapabilityPolicy(owner, ws.id, "slack.propose_message", { enabled: true });
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
  const propose = (channel: string, connectorAccountId?: string) =>
    createProposal({
      principal,
      capability: "slack.propose_message",
      args: { channel, text: "hello" },
      connectorAccountId,
    });
  return { fake, owner, approver, ws, c, propose };
}

describe("Slack channel restrictions apply at every stage", () => {
  it("blocks at proposal time, including for names that resolve to a restricted channel", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000001",
      effect: "allow",
    });
    expect((await s.propose("#ops")).state).toBe("PENDING_APPROVAL");
    const err = await s.propose("#secrets").catch((e) => e);
    expect(err).toBeInstanceOf(ProposalError);
    expect(err.code).toBe("policy_denied");
    expect(err.details.reasons[0].code).toBe("resource_not_allowed");
  });

  it("re-applies a rule added after the proposal existed: on the review screen, at approval, and at execution", async () => {
    const s = await setup();
    const p = await s.propose("#secrets");
    expect((await getProposalDetail(s.approver, s.ws.id, p.proposalId)).blockers).toEqual([]);
    const rule = await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000002",
      effect: "block",
    });

    expect(
      (await getProposalDetail(s.approver, s.ws.id, p.proposalId)).blockers.map((b) => b.code),
    ).toContain("resource_blocked");
    await expect(
      decideProposal({
        actorId: s.approver,
        workspaceId: s.ws.id,
        proposalId: p.proposalId,
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(DecisionError);

    await removeResourceRule(s.owner, s.ws.id, rule.id);
    await decideProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: p.proposalId,
      decision: "approve",
      expectedVersion: 1,
    });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000002",
      effect: "block",
    });
    const [row] = await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId));
    const exec = await evaluateForProposal("execute", row!, await getLatestArgs(p.proposalId));
    expect(exec.allowed).toBe(false);
    expect(exec.reasons.map((r) => r.code)).toContain("resource_blocked");
  });

  it("scopes a rule to one Slack connection and leaves the other alone", async () => {
    const s = await setup();
    const second = await connectAccount({
      workspaceId: s.ws.id,
      actorId: s.owner,
      provider: "slack",
      externalAccountId: "T0123ABCDE:user:U0MAYA123",
      displayName: "Acme (as maya)",
      grantedScopes: ["chat:write"],
      metadata: { senderMode: "user", teamId: "T0123ABCDE" },
      credentials: { accessToken: s.fake.userToken },
    });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000002",
      effect: "block",
      connectorAccountId: second.id,
    });
    // Blocked for the personal connection, still fine for the app connection.
    const blocked = await s.propose("#secrets", second.id).catch((e) => e);
    expect(blocked.code).toBe("policy_denied");
    expect((await s.propose("#secrets", s.c.id)).state).toBe("PENDING_APPROVAL");
  });

  it("is reflected in discovery: the picker marks blocked and unlisted channels", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000001",
      effect: "allow",
    });
    const { channels: out } = await listChannelChoices(s.owner, s.c.id, s.fake.sf);
    expect(Object.fromEntries(out.map((c) => [c.name, c.permitted]))).toEqual({
      ops: true,
      secrets: false,
    });
  });

  it("only accepts well-formed channel rules and keeps 'warn' for email domains", async () => {
    const s = await setup();
    await expect(
      setResourceRule(s.owner, s.ws.id, { kind: "slack_channel", value: "#ops", effect: "allow" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      setResourceRule(s.owner, s.ws.id, {
        kind: "slack_channel",
        value: "c0000000001",
        effect: "warn",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      (
        await setResourceRule(s.owner, s.ws.id, {
          kind: "slack_channel",
          value: "c0000000001",
          effect: "allow",
        })
      ).value,
    ).toBe("C0000000001");
  });
});
