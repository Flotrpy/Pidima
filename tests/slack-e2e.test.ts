import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "@/db/client";
import { executions, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import { connectAccount } from "@/server/connectors";
import { decideProposal } from "@/server/decisions";
import { editProposal } from "@/server/edits";
import { startExecutor } from "@/server/executor";
import { getProposalDetail } from "@/server/inbox";
import {
  createAuthorizationCode,
  createGrant,
  exchangeAuthorizationCode,
  getClient,
  pkceChallenge,
  registerClient,
} from "@/server/mcp-oauth";
import { updateCapabilityPolicy } from "@/server/policy";
import { getReceiptsForProposal } from "@/server/receipts";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeSlack, type FakeSlackOptions } from "./fake-slack";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

/**
 * Fixture-based end-to-end scenarios: a real MCP client speaks to the real gateway over the real
 * Streamable HTTP handler and OAuth tokens; only GitHub itself is a fixture. These do NOT replace
 * the live-provider and real-Claude acceptance tests described in docs/testing.md.
 */
async function world(gh: FakeSlackOptions = {}) {
  const fake = fakeSlack({
    channels: [{ id: "C0000000001", name: "ops", is_member: true }],
    ...gh,
  });
  setTransportOverride("slack", fake.sf);
  const ownerEmail = `e2e${Math.random()}@example.test`;
  const owner = await (async () => (
    await signInAs(ownerEmail),
    (await getDb().select().from(users).where(eq(users.email, ownerEmail)))[0]!.id
  ))();
  const ws = await createWorkspace(owner, "E2E");
  await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "slack",
    externalAccountId: "T0123ABCDE:bot",
    displayName: "Acme",
    grantedScopes: ["chat:write", "channels:read", "groups:read"],
    metadata: { senderMode: "bot", teamId: "T0123ABCDE", teamName: "Acme" },
    credentials: { accessToken: fake.botToken },
  });
  await updateCapabilityPolicy(owner, ws.id, "slack.propose_message", { enabled: true });
  const aEmail = `rev${Math.random()}@example.test`;
  await signInAs(aEmail);
  const approver = (await getDb().select().from(users).where(eq(users.email, aEmail)))[0]!.id;
  const { url } = await inviteMember(owner, ws.id, aEmail, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);

  const reg = await registerClient({
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
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
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: pkceChallenge(verifier),
    resource: mcpResourceUrl(),
  });
  const tokens = await exchangeAuthorizationCode({
    clientId: reg.client_id,
    code,
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeVerifier: verifier,
  });
  const claude = new Client({ name: "claude-test", version: "1" });
  await claude.connect(
    new StreamableHTTPClientTransport(new URL(mcpResourceUrl()), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      fetch: (i, init) =>
        handleMcpRequest(
          new Request(i as string, init),
          authenticateBearer,
          protectedResourceMetadataUrl(),
        ),
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await claude.callTool({ name, arguments: args });
    return {
      isError: !!r.isError,
      out: (r.structuredContent ?? {}) as Record<string, any>,
      text: (r.content as { text: string }[])[0]?.text ?? "",
    };
  };
  const issueArgs = { channel: "#ops", text: "Deploy finished" };
  return {
    fake,
    owner,
    approver,
    ws,
    claude,
    call,
    issueArgs,
    decide: (id: string, d: "approve" | "deny" | "cancel", v = 1) =>
      decideProposal({
        actorId: approver,
        workspaceId: ws.id,
        proposalId: id,
        decision: d,
        expectedVersion: v,
      }),
  };
}

describe("Slack end to end: Claude proposes, a person decides, the message is posted once", () => {
  it("happy path with an edit", async () => {
    const stop = startExecutor();
    try {
      const w = await world();
      expect((await w.claude.listTools()).tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["slack.propose_message", "action.get_status"]),
      );
      const prop = await w.call("slack.propose_message", w.issueArgs);
      expect(prop.isError).toBe(false);
      const id = prop.out.proposal_id as string;
      expect(w.fake.messages).toHaveLength(0);
      const d = await getProposalDetail(w.approver, w.ws.id, id);
      expect(d.destination).toBe("#ops \u00b7 Acme");
      await editProposal({
        actorId: w.approver,
        workspaceId: w.ws.id,
        proposalId: id,
        expectedVersion: 1,
        args: { channel: "#ops", text: "Deploy finished (v2)" },
      });
      await expect(w.decide(id, "approve", 1)).rejects.toMatchObject({ code: "conflict" });
      await w.decide(id, "approve", 2);
      expect(w.fake.messages).toHaveLength(1);
      expect(w.fake.messages[0]).toMatchObject({
        channel: "C0000000001",
        text: "Deploy finished (v2)",
        as: "bot",
      });
      const s = await w.call("action.get_status", { proposal_id: id });
      expect(s.out).toMatchObject({ state: "SUCCEEDED", terminal: true, edited_by_human: true });
      const [r] = await getReceiptsForProposal(w.owner, w.ws.id, id);
      expect(r!.body).toMatchObject({
        finalState: "SUCCEEDED",
        humanEdits: { count: 1 },
        execution: { result: { details: { sentAs: "app" } } },
      });
    } finally {
      stop();
    }
  });

  it("denial posts nothing; retries and repeated approvals post once", async () => {
    const stop = startExecutor();
    try {
      const w = await world();
      const a = (await w.call("slack.propose_message", w.issueArgs)).out.proposal_id as string;
      await w.decide(a, "deny");
      expect(w.fake.messages).toHaveLength(0);
      const first = await w.call("slack.propose_message", {
        ...w.issueArgs,
        client_request_id: "r1",
      });
      const retry = await w.call("slack.propose_message", {
        ...w.issueArgs,
        client_request_id: "r1",
      });
      expect(retry.out.proposal_id).toBe(first.out.proposal_id);
      await Promise.all([1, 2, 3].map(() => w.decide(first.out.proposal_id, "approve")));
      expect(w.fake.messages).toHaveLength(1);
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

  it.each([
    [
      "app removed from channel",
      { errors: { "chat.postMessage": "not_in_channel" } },
      "FAILED",
      /no longer accessible/i,
    ],
    ["token revoked", { errors: { "chat.postMessage": "token_revoked" } }, "FAILED", /reconnect/i],
    [
      "Slack down while posting",
      { statuses: { "chat.postMessage": 503 } },
      "OUTCOME_UNKNOWN",
      /verify/i,
    ],
    ["lost response after posting", { dropPostResponse: true }, "OUTCOME_UNKNOWN", /verify/i],
  ] as const)("reports honestly: %s", async (_n, opts, state, text) => {
    const stop = startExecutor();
    try {
      const w = await world(opts);
      const id = (await w.call("slack.propose_message", w.issueArgs)).out.proposal_id as string;
      await w.decide(id, "approve");
      const s = await w.call("action.get_status", { proposal_id: id });
      expect(s.out.state).toBe(state);
      expect(s.out.status_text).toMatch(text);
      expect(s.out.status_text).not.toMatch(/completed/i);
      expect(w.fake.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("an expired proposal cannot be approved or posted", async () => {
    const w = await world();
    const id = (await w.call("slack.propose_message", w.issueArgs)).out.proposal_id as string;
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, id));
    await expect(w.decide(id, "approve")).rejects.toMatchObject({ code: "not_pending" });
    expect(w.fake.messages).toHaveLength(0);
  });
});
