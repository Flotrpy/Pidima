import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "@/db/client";
import { connectorAccounts, executions, mcpGrants, proposals, users } from "@/db/schema";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import { toProposalArgs } from "@/mcp/tool-defs";
import type { McpScope } from "@/mcp/scopes";
import {
  createAuthorizationCode,
  createGrant,
  exchangeAuthorizationCode,
  pkceChallenge,
  registerClient,
  getClient,
} from "@/server/mcp-oauth";
import { callProposeTool } from "@/server/mcp-tools";
import { updateCapabilityPolicy } from "@/server/policy";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup(scopes: McpScope[] = ["proposals:create", "proposals:read"]) {
  const email = `mt${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Tools");
  const reg = await registerClient({
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"],
  });
  const client = (await getClient(reg.client_id))!;
  const grant = await createGrant({
    clientDbId: client.id,
    userId: u!.id,
    workspaceId: ws.id,
    scopes,
  });
  const verifier = randomBytes(48).toString("base64url");
  const code = await createAuthorizationCode({
    grantId: grant.id,
    redirectUri: "https://claude.ai/cb",
    codeChallenge: pkceChallenge(verifier),
    resource: mcpResourceUrl(),
  });
  const tokens = await exchangeAuthorizationCode({
    clientId: reg.client_id,
    code,
    redirectUri: "https://claude.ai/cb",
    codeVerifier: verifier,
  });
  return { owner: u!.id, ws, grant, clientId: reg.client_id, token: tokens.access_token };
}

async function connectGithub(s: Awaited<ReturnType<typeof setup>>, workspaceId = s.ws.id) {
  const [c] = await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId,
      provider: "github",
      externalAccountId: `${Math.random()}`,
      displayName: "gh",
      connectedByUserId: s.owner,
      grantedScopes: ["repo"],
    })
    .returning();
  return c!;
}

async function mcp(token: string) {
  const client = new Client({ name: "t", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpResourceUrl()), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (i, init) =>
      handleMcpRequest(
        new Request(i as string, init),
        authenticateBearer,
        protectedResourceMetadataUrl(),
      ),
  });
  await client.connect(transport);
  return client;
}

const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
const issue = {
  owner: "acme",
  repo: "platform",
  title: "Handle failed webhook retries",
  body: "Details",
};

describe("dynamic proposal-tool discovery", () => {
  it("exposes nothing until a capability is enabled AND a connector backs it", async () => {
    const s = await setup();
    const c = await mcp(s.token);
    expect(await names(c)).toEqual([]);
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    expect(await names(await mcp(s.token))).toEqual([]); // enabled but no connector
    await connectGithub(s);
    expect(await names(await mcp(s.token))).toEqual(["github.propose_issue"]);
  });

  it("never lists capabilities for services that are not connected or not enabled", async () => {
    const s = await setup();
    await connectGithub(s);
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    await updateCapabilityPolicy(s.owner, s.ws.id, "slack.propose_message", { enabled: true }); // enabled, no Slack connector
    expect(await names(await mcp(s.token))).toEqual(["github.propose_issue"]);
  });

  it("describes the tool with a typed input schema and honest annotations", async () => {
    const s = await setup();
    await connectGithub(s);
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    const [tool] = (await (await mcp(s.token)).listTools()).tools;
    expect(tool!.description).toMatch(/does NOT create the issue/);
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["owner", "repo", "title"]));
    expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("reflects policy changes on the next request", async () => {
    const s = await setup();
    await connectGithub(s);
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    expect(await names(await mcp(s.token))).toHaveLength(1);
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: false });
    expect(await names(await mcp(s.token))).toEqual([]);
  });

  it("shows no propose tools to a client that only holds the read scope", async () => {
    const s = await setup(["proposals:read"]);
    await connectGithub(s);
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    expect(await names(await mcp(s.token))).toEqual([]);
  });
});

describe("secure MCP execution boundary", () => {
  async function ready() {
    const s = await setup();
    const conn = await connectGithub(s);
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: true });
    return { ...s, conn };
  }

  it("turns a tool call into a pending proposal without performing the action", async () => {
    const s = await ready();
    const c = await mcp(s.token);
    const res = await c.callTool({ name: "github.propose_issue", arguments: issue });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as Record<string, string>;
    expect(out.state).toBe("PENDING_APPROVAL");
    expect(out.review_url).toBe(`http://localhost:3000/inbox/${out.proposal_id}`);
    expect(out.summary).toBe("Create GitHub issue in acme/platform");
    expect((res.content as { text: string }[])[0]!.text).toMatch(/Nothing has been done yet/);
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, out.proposal_id!));
    expect(p).toMatchObject({
      initiatedByUserId: s.owner,
      clientLabel: "Claude",
      state: "PENDING_APPROVAL",
    });
    expect(await getDb().select().from(executions)).toHaveLength(0);
  });

  it("returns field-level validation errors as tool errors", async () => {
    const s = await ready();
    const res = await (
      await mcp(s.token)
    ).callTool({
      name: "github.propose_issue",
      arguments: { owner: "a/b", repo: "x", title: "t" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/arguments were invalid/);
  });

  it("refuses a tool that is not currently offered, even if the name is known", async () => {
    const s = await ready();
    const c = await mcp(s.token);
    const res = await c
      .callTool({
        name: "slack.propose_message",
        arguments: { channel: "C0123456789", text: "hi" },
      })
      .catch((e) => ({ isError: true, thrown: String(e) }));
    expect(res.isError).toBe(true);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });

  it("re-checks the capability on the call itself, not just at discovery", async () => {
    const s = await ready();
    const principal = {
      grantId: s.grant.id,
      userId: s.owner,
      workspaceId: s.ws.id,
      clientLabel: "Claude",
      scopes: ["proposals:create"],
    };
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: false });
    const r = await callProposeTool(principal, "github.propose_issue", issue);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not currently available/);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });

  it("re-validates the grant if it is revoked after the token was accepted", async () => {
    const s = await ready();
    const principal = {
      grantId: s.grant.id,
      userId: s.owner,
      workspaceId: s.ws.id,
      clientLabel: "Claude",
      scopes: ["proposals:create"],
    };
    await getDb()
      .update(mcpGrants)
      .set({ revokedAt: new Date() })
      .where(eq(mcpGrants.id, s.grant.id));
    const r = await callProposeTool(principal, "github.propose_issue", issue);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no longer valid/);
  });

  it("does not trust a principal whose workspace or user does not match the grant", async () => {
    const s = await ready();
    const other = await setup();
    const forgedWs = {
      grantId: s.grant.id,
      userId: s.owner,
      workspaceId: other.ws.id,
      clientLabel: "Claude",
      scopes: ["proposals:create"],
    };
    expect((await callProposeTool(forgedWs, "github.propose_issue", issue)).isError).toBe(true);
    const forgedUser = {
      grantId: s.grant.id,
      userId: other.owner,
      workspaceId: s.ws.id,
      clientLabel: "Claude",
      scopes: ["proposals:create"],
    };
    expect((await callProposeTool(forgedUser, "github.propose_issue", issue)).isError).toBe(true);
    const good = {
      grantId: s.grant.id,
      userId: s.owner,
      workspaceId: s.ws.id,
      clientLabel: "Claude",
      scopes: ["proposals:create"],
    };
    expect(
      (await callProposeTool(good, "github.propose_issue", issue, "some-other-client")).isError,
    ).toBe(true);
    expect((await callProposeTool(good, "github.propose_issue", issue, s.clientId)).isError).toBe(
      false,
    );
  });

  it("cannot be pointed at another workspace's connector", async () => {
    const a = await ready();
    const b = await ready();
    const res = await (
      await mcp(a.token)
    ).callTool({
      name: "github.propose_issue",
      arguments: { ...issue, connector_account_id: b.conn.id },
    });
    expect(res.isError).toBe(true);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, b.ws.id)),
    ).toHaveLength(0);
  });

  it("returns the same proposal for a repeated client_request_id", async () => {
    const s = await ready();
    const c = await mcp(s.token);
    const a = await c.callTool({
      name: "github.propose_issue",
      arguments: { ...issue, client_request_id: "r1" },
    });
    const b = await c.callTool({
      name: "github.propose_issue",
      arguments: { ...issue, client_request_id: "r1" },
    });
    expect((a.structuredContent as any).proposal_id).toBe((b.structuredContent as any).proposal_id);
  });

  it("does not leak internals when something unexpected fails", async () => {
    const s = await ready();
    const principal = {
      grantId: "not-a-uuid",
      userId: s.owner,
      workspaceId: s.ws.id,
      clientLabel: "Claude",
      scopes: ["proposals:create"],
    };
    const r = await callProposeTool(principal, "github.propose_issue", issue);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Reference: /);
    expect(r.text).not.toMatch(/uuid|select|syntax|postgres/i);
  });
});

describe("tool input mapping", () => {
  it("maps snake_case tool inputs to internal argument names and drops control fields", () => {
    expect(
      toProposalArgs("slack.propose_message", {
        channel: "C1",
        text: "t",
        thread_ts: "1.2",
        client_request_id: "x",
        connector_account_id: "y",
      }),
    ).toEqual({ channel: "C1", text: "t", threadTs: "1.2" });
    expect(
      toProposalArgs("email.propose_message", {
        from: "a@b.co",
        to: ["c@d.co"],
        subject: "s",
        text_body: "b",
        html_body: "<p>b</p>",
      }),
    ).toEqual({
      from: "a@b.co",
      to: ["c@d.co"],
      subject: "s",
      textBody: "b",
      htmlBody: "<p>b</p>",
    });
    expect(
      toProposalArgs("github.propose_issue", {
        owner: "a",
        repo: "b",
        title: "t",
        client_request_id: "x",
      }),
    ).toEqual({ owner: "a", repo: "b", title: "t" });
  });
});
