import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, mcpClients, mcpGrants, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { decideProposal } from "@/server/decisions";
import { executeApprovedProposal } from "@/server/executor";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { assertNoSecrets, exportReceipt, getReceiptsForProposal } from "@/server/receipts";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGithub } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);
const BODY = "TOP-SECRET-ISSUE-BODY";

async function setup() {
  const fake = fakeGithub();
  setTransportOverride("github", fake.sf);
  const email = `ex${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Export");
  const { connectAccount } = await import("@/server/connectors");
  await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: fake.token },
  });
  void connectorAccounts;
  await updateCapabilityPolicy(owner, ws.id, "github.propose_issue", { enabled: true });
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
  const p = await createProposal({
    principal,
    capability: "github.propose_issue",
    args: { owner: "acme", repo: "platform", title: "T", body: BODY },
  });
  await decideProposal({
    actorId: approver,
    workspaceId: ws.id,
    proposalId: p.proposalId,
    decision: "approve",
    expectedVersion: 1,
  });
  await executeApprovedProposal(p.proposalId);
  const [rec] = await getReceiptsForProposal(owner, ws.id, p.proposalId);
  return { owner, ws, rec: rec!, approver };
}

describe("receipt export", () => {
  it("produces structured JSON with a notice, no credentials and no message body", async () => {
    const s = await setup();
    const { filename, json } = await exportReceipt(s.owner, s.ws.id, s.rec.id);
    expect(filename).toBe(`${s.rec.body.receiptNumber}.json`);
    const doc = JSON.parse(json);
    expect(doc).toMatchObject({
      format: "ai-action-inbox.receipt",
      version: 1,
      receipts: [{ receiptNumber: s.rec.body.receiptNumber, finalState: "SUCCEEDED" }],
    });
    expect(doc.notice).toMatch(/not a legal or cryptographic attestation/);
    expect(json).not.toContain(BODY);
    expect(json).not.toContain(fakeGithub().token);
    expect(json).not.toMatch(/access_token|refresh_token|client_secret|authorization/i);
  });

  it("is authorized: viewers may export, strangers and other workspaces get not-found", async () => {
    const s = await setup();
    const other = await setup();
    await expect(exportReceipt(other.owner, s.ws.id, s.rec.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(exportReceipt(other.owner, other.ws.id, s.rec.id)).rejects.toMatchObject({
      code: "not_found",
    });
    const v = `vw${Math.random()}@example.test`;
    await signInAs(v);
    const viewer = (await getDb().select().from(users).where(eq(users.email, v)))[0]!.id;
    const { url } = await inviteMember(s.owner, s.ws.id, v, "viewer");
    await acceptInvitation(viewer, url.split("/invite/")[1]!);
    expect((await exportReceipt(viewer, s.ws.id, s.rec.id)).json.length).toBeGreaterThan(100);
  });
});

describe("credential scrub (fails closed)", () => {
  it("blocks credential-shaped keys and values anywhere in the document", () => {
    for (const bad of [
      { a: { accessToken: "x" } },
      { a: ["ok", { password: "p" }] },
      { note: "xoxb-123-abc" },
      { note: "token gho_abcdef123456" },
      { h: "Bearer abc.def" },
      { k: "-----BEGIN PRIVATE KEY-----" },
      { c: "ya29.a0Af" },
    ]) {
      expect(() => assertNoSecrets(bad)).toThrow(/Export blocked/);
    }
    expect(() =>
      assertNoSecrets({ title: "Fix tokenizer bug", url: "https://github.com/a/b/issues/1", n: 3 }),
    ).not.toThrow();
  });
});
