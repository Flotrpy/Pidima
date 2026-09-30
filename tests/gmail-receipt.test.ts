import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { decideProposal } from "@/server/decisions";
import { editProposal } from "@/server/edits";
import { executeApprovedProposal } from "@/server/executor";
import { describeState } from "@/server/mcp-status";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { getReceiptsForProposal } from "@/server/receipts";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGmail, type FakeGmailOptions } from "./fake-gmail";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const SECRET = "CONFIDENTIAL-EMAIL-BODY-909";

async function user(email: string, name: string) {
  await signInAs(email, name);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}
async function setup(g: FakeGmailOptions = {}) {
  const fake = fakeGmail(g);
  setTransportOverride("gmail", fake.sf);
  const owner = await user(`er${Math.random()}@example.test`, "Maya Chen");
  const ws = await createWorkspace(owner, "Mail HQ");
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
  const approver = await user(`rv${Math.random()}@example.test`, "Dev Patel");
  const em = (await getDb().select().from(users).where(eq(users.id, approver)))[0]!.email;
  const { url } = await inviteMember(owner, ws.id, em, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const propose = (x: Record<string, unknown> = {}) =>
    createProposal({
      principal,
      capability: "email.propose_message",
      args: {
        from: "maya@acme.com",
        to: ["dev@acme.com"],
        bcc: ["legal@acme.com"],
        subject: "Q3",
        textBody: SECRET,
        ...x,
      },
    });
  return {
    owner,
    approver,
    ws,
    fake,
    propose,
    decide: (id: string, v = 1) =>
      decideProposal({
        actorId: approver,
        workspaceId: ws.id,
        proposalId: id,
        decision: "approve",
        expectedVersion: v,
      }),
    receipts: (id: string) => getReceiptsForProposal(owner, ws.id, id),
  };
}

describe("email receipt", () => {
  it("states provider acceptance, records recipients and message reference, and omits the body and tokens", async () => {
    const s = await setup();
    const p = await s.propose();
    await s.decide(p.proposalId);
    await executeApprovedProposal(p.proposalId);
    const [rec] = await s.receipts(p.proposalId);
    const r = rec!.body;
    expect(r).toMatchObject({
      finalState: "SUCCEEDED",
      initiatedBy: { name: "Maya Chen" },
      decision: { by: { name: "Dev Patel" } },
      connector: { provider: "gmail", displayName: "maya@acme.com" },
    });
    expect(r.execution!.result).toMatchObject({
      providerId: s.fake.sent[0]!.id,
      url: null,
      details: { messageId: s.fake.sent[0]!.id, recipientCount: 2, acceptedByProvider: true },
    });
    expect(r.execution!.result!.note).toMatch(/does not confirm delivery/);
    expect(r.action.facts).toEqual(
      expect.arrayContaining([
        { label: "From", value: "maya@acme.com" },
        { label: "To", value: "dev@acme.com" },
        { label: "BCC", value: "legal@acme.com" },
        { label: "Subject", value: "Q3" },
      ]),
    );
    const json = JSON.stringify(rec);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("ya29");
    expect(json).not.toMatch(/delivered to|was read/i);
  });

  it("records the human edit and the changed recipients in the diff", async () => {
    const s = await setup();
    const p = await s.propose();
    await editProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: p.proposalId,
      expectedVersion: 1,
      args: {
        from: "maya@acme.com",
        to: ["dev@acme.com", "ops@acme.com"],
        bcc: ["legal@acme.com"],
        subject: "Q3",
        textBody: SECRET,
      },
      reason: "Add ops",
    });
    await s.decide(p.proposalId, 2);
    await executeApprovedProposal(p.proposalId);
    const r = (await s.receipts(p.proposalId))[0]!.body;
    expect(r.humanEdits.versions[0]).toMatchObject({
      version: 2,
      by: { name: "Dev Patel" },
      reason: "Add ops",
    });
    expect(r.humanEdits.diff).toEqual([
      expect.objectContaining({ key: "to", kind: "list", added: ["ops@acme.com"] }),
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("records a rejected send honestly, with recovery guidance and no result", async () => {
    const s = await setup({ statuses: { "/messages/send": 401 } });
    const p = await s.propose();
    await s.decide(p.proposalId);
    await executeApprovedProposal(p.proposalId);
    const r = (await s.receipts(p.proposalId))[0]!.body;
    expect(r).toMatchObject({
      finalState: "FAILED",
      execution: { result: null, error: { category: "auth_expired" } },
    });
  });

  it("records an ambiguous send as unknown with verification guidance", async () => {
    const s = await setup({ dropSendResponse: true });
    const p = await s.propose();
    await s.decide(p.proposalId);
    await executeApprovedProposal(p.proposalId);
    const r = (await s.receipts(p.proposalId))[0]!.body;
    expect(r).toMatchObject({
      finalState: "OUTCOME_UNKNOWN",
      execution: { result: null, error: { category: "verification_required" } },
    });
  });
});

describe("status wording for Claude", () => {
  it("never claims delivery for email, while other actions keep the provider-confirmed wording", () => {
    const mail = describeState("SUCCEEDED", null, "email.propose_message").text;
    expect(mail).toMatch(/accepted the message/);
    expect(mail).toMatch(/not confirmed/);
    expect(describeState("SUCCEEDED", null, "github.propose_issue").text).toMatch(
      /provider confirmed/,
    );
  });
});
