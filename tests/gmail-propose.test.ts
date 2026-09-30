import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "@/db/client";
import { auditEvents, proposalVersions, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { emailMessageArgs } from "@/connectors/capabilities/email-message";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import { connectAccount } from "@/server/connectors";
import { editProposal } from "@/server/edits";
import { getProposalDetail } from "@/server/inbox";
import {
  createAuthorizationCode,
  createGrant,
  exchangeAuthorizationCode,
  getClient,
  pkceChallenge,
  registerClient,
} from "@/server/mcp-oauth";
import { setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGmail, type FakeGmailOptions } from "./fake-gmail";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup(slack: FakeGmailOptions = {}) {
  const fake = fakeGmail(slack);
  setTransportOverride("gmail", fake.sf);
  const email = `sp${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Slack Propose");
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
  const reg = await registerClient({
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"],
  });
  const grant = await createGrant({
    clientDbId: (await getClient(reg.client_id))!.id,
    userId: owner,
    workspaceId: ws.id,
    scopes: ["proposals:create", "proposals:read"],
  });
  const verifier = randomBytes(48).toString("base64url");
  const code = await createAuthorizationCode({
    grantId: grant.id,
    redirectUri: "https://claude.ai/cb",
    codeChallenge: pkceChallenge(verifier),
    resource: mcpResourceUrl(),
  });
  const t = await exchangeAuthorizationCode({
    clientId: reg.client_id,
    code,
    redirectUri: "https://claude.ai/cb",
    codeVerifier: verifier,
  });
  const mcp = new Client({ name: "t", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(mcpResourceUrl()), {
      requestInit: { headers: { authorization: `Bearer ${t.access_token}` } },
      fetch: (i, init) =>
        handleMcpRequest(
          new Request(i as string, init),
          authenticateBearer,
          protectedResourceMetadataUrl(),
        ),
    }),
  );
  const aemail = `rv${Math.random()}@example.test`;
  await signInAs(aemail);
  const approver = (await getDb().select().from(users).where(eq(users.email, aemail)))[0]!.id;
  const { url } = await inviteMember(owner, ws.id, aemail, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const propose = async (args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name: "email.propose_message", arguments: args });
    return {
      isError: !!r.isError,
      out: (r.structuredContent ?? {}) as Record<string, any>,
      text: (r.content as { text: string }[])[0]!.text,
    };
  };
  return { fake, owner, approver, ws, propose };
}

const ok = {
  from: "maya@acme.com",
  to: ["dev@acme.com"],
  subject: "Launch notes",
  text_body: "Hello team",
};

describe("email.propose_message", () => {
  it("creates a pending proposal, validating the sender locally, and never sends", async () => {
    const s = await setup();
    const r = await s.propose(ok);
    expect(r.isError).toBe(false);
    expect(r.out.state).toBe("PENDING_APPROVAL");
    expect(r.out.summary).toBe("Send email to 1 recipient(s)");
    expect(s.fake.sent).toHaveLength(0);
    expect(s.fake.calls.every((c) => !c.path.includes("/messages"))).toBe(true);
    const d = await getProposalDetail(s.approver, s.ws.id, r.out.proposal_id);
    expect(d.fields.find((f) => f.label === "From")).toMatchObject({
      value: "maya@acme.com",
      emphasis: true,
    });
    expect(d.fields.find((f) => f.label === "To")).toMatchObject({
      value: ["dev@acme.com"],
      emphasis: true,
    });
  });

  it("shows BCC recipients prominently and counts every distinct recipient", async () => {
    const s = await setup();
    const r = await s.propose({ ...ok, cc: ["a@acme.com"], bcc: ["b@other.com"] });
    expect(r.out.summary).toBe("Send email to 3 recipient(s)");
    const d = await getProposalDetail(s.approver, s.ws.id, r.out.proposal_id);
    expect(d.fields.find((f) => f.label.startsWith("BCC"))).toMatchObject({
      value: ["b@other.com"],
      emphasis: true,
    });
  });

  it("rejects a From address the connection cannot send as", async () => {
    const s = await setup();
    const r = await s.propose({ ...ok, from: "ceo@acme.com" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not a sender this connection can use. Available: maya@acme.com/);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });

  it("rejects malformed content at the schema, including header injection, before anything is stored", () => {
    const base = { from: "maya@acme.com", to: ["dev@acme.com"], subject: "s", textBody: "b" };
    for (const bad of [
      { ...base, to: [] },
      { ...base, to: ["a@b.com\r\nBcc: x@y.com"] },
      { ...base, to: ["Dev <dev@acme.com>"] },
      { ...base, textBody: undefined },
      { ...base, subject: "" },
      { ...base, textBody: "x".repeat(100_001) },
      { ...base, to: Array.from({ length: 21 }, (_, i) => `u${i}@a.com`) },
    ]) {
      expect(emailMessageArgs.safeParse(bad).success).toBe(false);
    }
    expect(
      emailMessageArgs.parse({ ...base, subject: "Line\r\nBcc: evil@x.com" }).subject,
    ).not.toMatch(/[\r\n]/);
  });

  it("returns field-level errors to the AI", async () => {
    const s = await setup();
    const r = await s.propose({ ...ok, to: ["not-an-email"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/to/);
  });

  it("shows HTML as source text and never as markup", async () => {
    const s = await setup();
    const r = await s.propose({ ...ok, html_body: "<p onclick=alert(1)>Hi</p>" });
    const d = await getProposalDetail(s.approver, s.ws.id, r.out.proposal_id);
    const f = d.fields.find((x) => x.label.startsWith("HTML body"))!;
    expect(f).toMatchObject({ kind: "longtext", value: "<p onclick=alert(1)>Hi</p>" });
  });

  it("is idempotent for a repeated client_request_id", async () => {
    const s = await setup();
    const a = await s.propose({ ...ok, client_request_id: "e1" });
    const b = await s.propose({ ...ok, client_request_id: "e1" });
    expect(b.out.proposal_id).toBe(a.out.proposal_id);
  });

  it("is not offered until the capability is enabled and a connector with the send scope exists", async () => {
    const s = await setup();
    await updateCapabilityPolicy(s.owner, s.ws.id, "email.propose_message", { enabled: false });
    const r = await s.propose(ok);
    expect(r.isError).toBe(true);
  });
});
