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
import { decideProposal } from "@/server/decisions";
import { executions } from "@/db/schema";
import { startExecutor } from "@/server/executor";
import { getReceiptsForProposal } from "@/server/receipts";
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
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    return {
      isError: !!r.isError,
      out: (r.structuredContent ?? {}) as Record<string, any>,
      text: (r.content as { text: string }[])[0]!.text,
    };
  };
  const decide = (id: string, d: "approve" | "deny", v = 1) =>
    decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: id,
      decision: d,
      expectedVersion: v,
    });
  return { fake, owner, approver, ws, propose, call, decide };
}

const ok = {
  from: "maya@acme.com",
  to: ["dev@acme.com", "ops@acme.com"],
  cc: ["pm@partner.com"],
  subject: "Launch notes",
  text_body: "Shipping today.",
};
const sends = (f: ReturnType<typeof fakeGmail>) =>
  f.calls.filter((c) => c.path.endsWith("/messages/send"));

describe("Email end to end: Claude proposes, a person decides, the message is accepted once", () => {
  it("multiple recipients with a human edit, approved and sent once", async () => {
    const stop = startExecutor();
    try {
      const w = await setup();
      const id = (await w.call("email.propose_message", ok)).out.proposal_id as string;
      expect(w.fake.sent).toHaveLength(0);
      await editProposal({
        actorId: w.approver,
        workspaceId: w.ws.id,
        proposalId: id,
        expectedVersion: 1,
        args: {
          from: "maya@acme.com",
          to: ["dev@acme.com"],
          cc: ["pm@partner.com"],
          bcc: [],
          subject: "Launch notes",
          textBody: "Shipping today.",
        },
        reason: "Drop ops",
      });
      await expect(w.decide(id, "approve", 1)).rejects.toMatchObject({ code: "conflict" });
      await w.decide(id, "approve", 2);
      expect(w.fake.sent).toHaveLength(1);
      expect(w.fake.sent[0]!.mime).toMatch(/To: dev@acme.com\r\nCc: pm@partner.com\r\n/);
      expect(w.fake.sent[0]!.mime).not.toContain("ops@acme.com");
      const s = await w.call("action.get_status", { proposal_id: id });
      expect(s.out).toMatchObject({ state: "SUCCEEDED", terminal: true, edited_by_human: true });
      expect(s.out.status_text).toMatch(/Delivery to an inbox and reading are not confirmed/);
      const [r] = await getReceiptsForProposal(w.owner, w.ws.id, id);
      expect(r!.body).toMatchObject({ finalState: "SUCCEEDED", humanEdits: { count: 1 } });
    } finally {
      stop();
    }
  });

  it("denial sends nothing; retries and repeated approvals send once", async () => {
    const stop = startExecutor();
    try {
      const w = await setup();
      const a = (await w.call("email.propose_message", ok)).out.proposal_id as string;
      await w.decide(a, "deny");
      expect(w.fake.sent).toHaveLength(0);
      const first = await w.call("email.propose_message", { ...ok, client_request_id: "m1" });
      expect(
        (await w.call("email.propose_message", { ...ok, client_request_id: "m1" })).out.proposal_id,
      ).toBe(first.out.proposal_id);
      await Promise.all([1, 2, 3].map(() => w.decide(first.out.proposal_id, "approve")));
      expect(w.fake.sent).toHaveLength(1);
      expect(
        await getDb()
          .select()
          .from(executions)
          .where(eq(executions.proposalId, first.out.proposal_id)),
      ).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("an invalid sender never becomes a proposal", async () => {
    const w = await setup();
    const r = await w.call("email.propose_message", { ...ok, from: "ceo@acme.com" });
    expect(r.isError).toBe(true);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, w.ws.id)),
    ).toHaveLength(0);
  });

  it.each([
    ["Google rejects the token", { statuses: { "/messages/send": 401 } }, "FAILED", /reconnect/i],
    [
      "Google rate limits",
      { statuses: { "/messages/send": 429 } },
      "FAILED",
      /slow down|rate limited/i,
    ],
    [
      "Google is down while sending",
      { statuses: { "/messages/send": 503 } },
      "OUTCOME_UNKNOWN",
      /verify/i,
    ],
    [
      "the response is lost after Gmail accepted it",
      { dropSendResponse: true },
      "OUTCOME_UNKNOWN",
      /verify/i,
    ],
  ] as const)("reports honestly: %s", async (_n, o, state, text) => {
    const stop = startExecutor();
    try {
      const w = await setup(o);
      const id = (await w.call("email.propose_message", ok)).out.proposal_id as string;
      await w.decide(id, "approve");
      const s = await w.call("action.get_status", { proposal_id: id });
      expect(s.out.state).toBe(state);
      expect(s.out.status_text).toMatch(text);
      expect(s.out.status_text).not.toMatch(/sent|completed/i);
      expect(sends(w.fake)).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("an expired proposal cannot be approved or sent", async () => {
    const w = await setup();
    const id = (await w.call("email.propose_message", ok)).out.proposal_id as string;
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, id));
    await expect(w.decide(id, "approve")).rejects.toMatchObject({ code: "not_pending" });
    expect(w.fake.sent).toHaveLength(0);
  });
});
