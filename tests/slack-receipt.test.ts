import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, users } from "@/db/schema";
import { argsHash } from "@/approvals/hashing";
import { setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { decideProposal } from "@/server/decisions";
import { editProposal } from "@/server/edits";
import { claimExecution, finalizeExecution } from "@/server/execution-claim";
import { executeApprovedProposal, runExecutionMaintenance } from "@/server/executor";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { getReceiptsForProposal } from "@/server/receipts";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeSlack, type FakeSlackOptions } from "./fake-slack";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const SECRET_TEXT = "Q3 numbers are confidential: revenue 12.3M";
const channels = [{ id: "C0000000001", name: "finance", is_member: true }];

async function user(email: string, name: string) {
  await signInAs(email, name);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function setup(slack: FakeSlackOptions = {}, mode: "bot" | "user" = "bot") {
  const fake = fakeSlack({ channels, ...slack });
  setTransportOverride("slack", fake.sf);
  const owner = await user(`sr${Math.random()}@example.test`, "Maya Chen");
  const ws = await createWorkspace(owner, "Finance HQ");
  await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "slack",
    externalAccountId: mode === "bot" ? "T0123ABCDE:bot" : "T0123ABCDE:user:U0MAYA123",
    displayName: "Acme",
    grantedScopes: ["chat:write", "channels:read", "groups:read"],
    metadata: { senderMode: mode, teamId: "T0123ABCDE", teamName: "Acme", userName: "maya" },
    credentials: { accessToken: mode === "bot" ? fake.botToken : fake.userToken },
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
  const approver = await user(`rv${Math.random()}@example.test`, "Dev Patel");
  const email = (await getDb().select().from(users).where(eq(users.id, approver)))[0]!.email;
  const { url } = await inviteMember(owner, ws.id, email, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const propose = (args: Record<string, unknown> = {}) =>
    createProposal({
      principal,
      capability: "slack.propose_message",
      args: { channel: "#finance", text: SECRET_TEXT, ...args },
    });
  const decide = (id: string, decision: "approve" | "deny", v = 1) =>
    decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: id,
      decision,
      expectedVersion: v,
    });
  return {
    fake,
    owner,
    approver,
    ws,
    propose,
    decide,
    receipts: (id: string) => getReceiptsForProposal(owner, ws.id, id),
  };
}

describe("receipt for a posted Slack message", () => {
  it("records channel, message reference, sender presentation, decision evidence and hashes, without the text or tokens", async () => {
    const s = await setup();
    const p = await s.propose();
    await s.decide(p.proposalId, "approve");
    await executeApprovedProposal(p.proposalId);

    const [rec] = await s.receipts(p.proposalId);
    const r = rec!.body;
    expect(r).toMatchObject({
      finalState: "SUCCEEDED",
      client: { label: "Claude" },
      workspace: { name: "Finance HQ" },
      initiatedBy: { name: "Maya Chen" },
      decision: { outcome: "approved", by: { name: "Dev Patel" } },
      connector: { provider: "slack", displayName: "Acme", externalAccountId: "T0123ABCDE:bot" },
      action: { destination: "C0000000001", summary: "Send Slack message to C0000000001" },
      execution: { state: "SUCCEEDED", attempts: 1, error: null },
    });
    expect(r.action.facts).toEqual(
      expect.arrayContaining([
        { label: "Channel", value: "#finance (C0000000001)" },
        { label: "Slack workspace", value: "Acme" },
        { label: "Message length", value: `${SECRET_TEXT.length} characters` },
      ]),
    );
    expect(r.execution!.result).toMatchObject({
      providerId: s.fake.messages[0]!.ts,
      url: expect.stringContaining("/archives/C0000000001/p"),
      details: {
        channel: "C0000000001",
        messageTs: s.fake.messages[0]!.ts,
        threadTs: null,
        sentAs: "app",
      },
    });
    expect(r.hashes.approvedContent).toBe(argsHash({ channel: "C0000000001", text: SECRET_TEXT }));
    expect(r.hashes.originalProposal).toBe(r.hashes.approvedContent);

    const json = JSON.stringify(rec);
    expect(json).not.toContain(SECRET_TEXT);
    expect(json).not.toContain("xoxb-");
    expect(json).not.toMatch(/access_token|authorization|client_secret/i);
  });

  it("states that a personal-account message was sent as a person", async () => {
    const s = await setup({}, "user");
    const p = await s.propose();
    await s.decide(p.proposalId, "approve");
    await executeApprovedProposal(p.proposalId);
    expect((await s.receipts(p.proposalId))[0]!.body.execution!.result!.details.sentAs).toBe(
      "person",
    );
  });

  it("identifies who edited the message and shows the diff from the AI's original", async () => {
    const s = await setup();
    const p = await s.propose({ text: "Numbers attached." });
    await editProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: p.proposalId,
      expectedVersion: 1,
      args: { channel: "#finance", text: "Numbers attached. Please do not forward." },
      reason: "Add handling note",
    });
    await s.decide(p.proposalId, "approve", 2);
    await executeApprovedProposal(p.proposalId);
    const r = (await s.receipts(p.proposalId))[0]!.body;
    expect(r.proposal.version).toBe(2);
    expect(r.hashes.originalProposal).not.toBe(r.hashes.approvedContent);
    expect(r.humanEdits.versions).toEqual([
      expect.objectContaining({
        version: 2,
        by: expect.objectContaining({ name: "Dev Patel" }),
        reason: "Add handling note",
      }),
    ]);
    expect(r.humanEdits.diff.map((d) => d.key)).toEqual(["text"]);
    expect(s.fake.messages[0]!.text).toBe("Numbers attached. Please do not forward.");
  });

  it("records a denial and a confirmed failure with recovery guidance", async () => {
    const s = await setup();
    const denied = await s.propose();
    await s.decide(denied.proposalId, "deny");
    expect((await s.receipts(denied.proposalId))[0]!.body).toMatchObject({
      finalState: "DENIED",
      execution: null,
    });

    const f = await setup({ errors: { "chat.postMessage": "not_in_channel" } });
    const p = await f.propose();
    await f.decide(p.proposalId, "approve");
    await executeApprovedProposal(p.proposalId);
    const r = (await f.receipts(p.proposalId))[0]!.body;
    expect(r.finalState).toBe("FAILED");
    expect(r.execution!.error).toMatchObject({ category: "destination_inaccessible" });
    expect(r.execution!.error!.recovery.length).toBeGreaterThan(10);
    expect(r.execution!.result).toBeNull();
  });

  it("records an ambiguous post as unknown and, without a lookup, never upgrades it to success", async () => {
    const s = await setup({ dropPostResponse: true });
    const p = await s.propose();
    await s.decide(p.proposalId, "approve");
    await executeApprovedProposal(p.proposalId);
    await runExecutionMaintenance();
    const rs = await s.receipts(p.proposalId);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.body).toMatchObject({
      finalState: "OUTCOME_UNKNOWN",
      execution: { result: null, error: { category: "verification_required" } },
    });
    expect(rs[0]!.body.execution!.error!.recovery).toMatch(/Check the destination directly/);
  });
});

describe("provider detail allowlist", () => {
  it("drops unexpected provider fields so tokens or bodies can never reach a receipt", async () => {
    const s = await setup();
    const p = await s.propose();
    await s.decide(p.proposalId, "approve");
    const claim = (await claimExecution(p.proposalId, "w"))!;
    await finalizeExecution(claim, {
      status: "succeeded",
      providerId: "1700000000.000100",
      url: "https://acme.slack.com/archives/C0000000001/p1700000000000100",
      details: {
        channel: "C0000000001",
        messageTs: "1700000000.000100",
        sentAs: "app",
        token: "xoxb-should-never-appear",
        body: SECRET_TEXT,
        nested: { a: 1 },
        authorization: "Bearer x",
      },
    });
    const r = (await s.receipts(p.proposalId))[0]!.body;
    expect(Object.keys(r.execution!.result!.details).sort()).toEqual([
      "channel",
      "messageTs",
      "sentAs",
    ]);
    const json = JSON.stringify(r);
    expect(json).not.toContain("xoxb-should-never-appear");
    expect(json).not.toContain(SECRET_TEXT);
    expect(json).not.toContain("Bearer");
  });
});
