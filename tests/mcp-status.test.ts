import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "@/db/client";
import { connectorAccounts, proposals, users } from "@/db/schema";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import type { McpScope } from "@/mcp/scopes";
import { decideProposal } from "@/server/decisions";
import { editProposal } from "@/server/edits";
import { claimExecution, finalizeExecution } from "@/server/execution-claim";
import {
  createAuthorizationCode,
  createGrant,
  exchangeAuthorizationCode,
  getClient,
  pkceChallenge,
  registerClient,
} from "@/server/mcp-oauth";
import { describeState } from "@/server/mcp-status";
import { updateCapabilityPolicy } from "@/server/policy";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const SECRET_BODY = "TOP-SECRET-ISSUE-BODY-42";

async function mint(userId: string, wsId: string, scopes: McpScope[], clientName = "Claude") {
  const reg = await registerClient({
    client_name: clientName,
    redirect_uris: ["https://claude.ai/cb"],
  });
  const client = (await getClient(reg.client_id))!;
  const grant = await createGrant({ clientDbId: client.id, userId, workspaceId: wsId, scopes });
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
  return { token: t.access_token };
}

async function connect(token: string) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(mcpResourceUrl()), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (i, init) =>
        handleMcpRequest(
          new Request(i as string, init),
          authenticateBearer,
          protectedResourceMetadataUrl(),
        ),
    }),
  );
  return c;
}

async function setup() {
  const email = `ms${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Status");
  await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId: ws.id,
      provider: "github",
      externalAccountId: `${Math.random()}`,
      displayName: "gh",
      connectedByUserId: u!.id,
      grantedScopes: ["repo"],
    });
  await updateCapabilityPolicy(u!.id, ws.id, "github.propose_issue", { enabled: true });
  const aemail = `ap${Math.random()}@example.test`;
  await signInAs(aemail);
  const [a] = await getDb().select().from(users).where(eq(users.email, aemail));
  const { url } = await inviteMember(u!.id, ws.id, aemail, "approver");
  await acceptInvitation(a!.id, url.split("/invite/")[1]!);
  const { token } = await mint(u!.id, ws.id, ["proposals:create", "proposals:read"]);
  const client = await connect(token);
  const propose = async (title = "Handle retries") => {
    const r = await client.callTool({
      name: "github.propose_issue",
      arguments: { owner: "acme", repo: "platform", title, body: SECRET_BODY },
    });
    return (r.structuredContent as { proposal_id: string }).proposal_id;
  };
  const status = async (id: string, c = client) =>
    c.callTool({ name: "action.get_status", arguments: { proposal_id: id } });
  const decide = (id: string, decision: "approve" | "deny" | "cancel", expectedVersion = 1) =>
    decideProposal({
      actorId: a!.id,
      workspaceId: ws.id,
      proposalId: id,
      decision,
      expectedVersion,
    });
  return { owner: u!.id, approver: a!.id, ws, client, propose, status, decide };
}

const sc = (r: unknown) =>
  (r as { structuredContent?: unknown }).structuredContent as Record<string, any>;

describe("action.get_status", () => {
  it("is offered only with the read scope", async () => {
    const s = await setup();
    const { token } = await mint(s.owner, s.ws.id, ["proposals:create"], "Create-only");
    const names = (await (await connect(token)).listTools()).tools.map((t) => t.name);
    expect(names).toContain("github.propose_issue");
    expect(names).not.toContain("action.get_status");
    expect(names).not.toContain("action.list_recent");
    expect((await s.client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["action.get_status", "action.list_recent"]),
    );
  });

  it("follows a proposal through review, edit, approval and a verified result without ever returning content", async () => {
    const s = await setup();
    const id = await s.propose();
    let r = sc(await s.status(id));
    expect(r).toMatchObject({
      state: "PENDING_APPROVAL",
      terminal: false,
      edited_by_human: false,
      version: 1,
      summary: "Create GitHub issue in acme/platform",
    });
    expect(r.review_url).toBe(`http://localhost:3000/inbox/${id}`);
    expect(r.status_text).toMatch(/Nothing has been done yet/);

    await editProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: id,
      expectedVersion: 1,
      args: { owner: "acme", repo: "platform", title: "Edited", body: SECRET_BODY },
    });
    r = sc(await s.status(id));
    expect(r).toMatchObject({ edited_by_human: true, version: 2 });

    await s.decide(id, "approve", 2);
    r = sc(await s.status(id));
    expect(r).toMatchObject({ state: "APPROVED", decision: "approved", terminal: false });

    const claim = (await claimExecution(id, "w"))!;
    await finalizeExecution(claim, {
      status: "succeeded",
      providerId: "123",
      url: "https://github.com/acme/platform/issues/123",
    });
    const done = await s.status(id);
    r = sc(done);
    expect(r).toMatchObject({
      state: "SUCCEEDED",
      terminal: true,
      execution: {
        state: "SUCCEEDED",
        result_url: "https://github.com/acme/platform/issues/123",
        result_id: "123",
      },
    });
    expect(JSON.stringify(done)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(done)).not.toContain("Edited");
  });

  it("reports failure with recovery guidance and unknown outcomes as needing verification", async () => {
    const s = await setup();
    const a = await s.propose("a");
    await s.decide(a, "approve");
    await finalizeExecution((await claimExecution(a, "w"))!, {
      status: "failed",
      category: "destination_inaccessible",
      message: "Repository not found",
    });
    const failed = sc(await s.status(a));
    expect(failed).toMatchObject({
      state: "FAILED",
      terminal: true,
      execution: { error_category: "destination_inaccessible" },
    });
    expect(failed.status_text).toMatch(/no longer accessible/i);

    const b = await s.propose("b");
    await s.decide(b, "approve");
    await finalizeExecution((await claimExecution(b, "w"))!, {
      status: "unknown",
      reason: "timeout",
    });
    const unknown = sc(await s.status(b));
    expect(unknown).toMatchObject({ state: "OUTCOME_UNKNOWN", terminal: false });
    expect(unknown.status_text).toMatch(/verify/i);
    expect(unknown.status_text).not.toMatch(/completed/i);
  });

  it("reports denial, cancellation and expiry as terminal", async () => {
    const s = await setup();
    const d = await s.propose("d");
    await s.decide(d, "deny");
    expect(sc(await s.status(d))).toMatchObject({
      state: "DENIED",
      terminal: true,
      decision: "denied",
    });
    const e = await s.propose("e");
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, e));
    expect(sc(await s.status(e))).toMatchObject({ state: "EXPIRED", terminal: true });
  });

  it("answers identically for unknown, malformed and other users' or workspaces' proposals", async () => {
    const a = await setup();
    const b = await setup();
    const mine = await a.propose();
    const theirs = await b.propose();
    const cross = await a.status(theirs);
    const missing = await a.status("00000000-0000-0000-0000-000000000000");
    const junk = await a.status("not-a-uuid");
    for (const r of [cross, missing, junk]) {
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0]!.text).toBe(
        "No proposal with that ID was found for this client.",
      );
    }
    expect((await a.status(mine)).isError).toBeFalsy();
  });

  it("does not show one client's proposals to a different client of the same user", async () => {
    const s = await setup();
    const id = await s.propose();
    const other = await connect(
      (await mint(s.owner, s.ws.id, ["proposals:create", "proposals:read"], "Another agent")).token,
    );
    expect((await s.status(id, other)).isError).toBe(true);
    expect(sc(await other.callTool({ name: "action.list_recent", arguments: {} })).count).toBe(0);
  });

  it("stops answering once the grant is revoked", async () => {
    const s = await setup();
    const id = await s.propose();
    const { mcpGrants } = await import("@/db/schema");
    await getDb()
      .update(mcpGrants)
      .set({ revokedAt: new Date() })
      .where(eq(mcpGrants.workspaceId, s.ws.id));
    await expect(s.status(id)).rejects.toThrow();
  });
});

describe("action.list_recent", () => {
  it("lists newest first, bounded, filterable, with summaries only", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await s.propose(`t${i}`));
      await new Promise((r) => setTimeout(r, 5));
    }
    await s.decide(ids[0]!, "deny");
    const all = sc(await s.client.callTool({ name: "action.list_recent", arguments: {} }));
    expect(all.count).toBe(4);
    expect(all.proposals.map((p: any) => p.proposal_id)).toEqual([...ids].reverse());
    const limited = sc(
      await s.client.callTool({ name: "action.list_recent", arguments: { limit: 2 } }),
    );
    expect(limited.count).toBe(2);
    const pending = sc(
      await s.client.callTool({
        name: "action.list_recent",
        arguments: { state: "PENDING_APPROVAL" },
      }),
    );
    expect(pending.count).toBe(3);
    expect(JSON.stringify(all)).not.toContain(SECRET_BODY);
    expect(all.proposals[0].summary).toBe("Create GitHub issue in acme/platform");
  });

  it("rejects out-of-range limits at the schema", async () => {
    const s = await setup();
    const r = await s.client.callTool({ name: "action.list_recent", arguments: { limit: 500 } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/limit/);
  });
});

describe("state descriptions", () => {
  it("never describes an unknown outcome or pending item as done", () => {
    expect(describeState("OUTCOME_UNKNOWN").text).not.toMatch(/completed|confirmed the result/i);
    expect(describeState("PENDING_APPROVAL").text).toMatch(/Nothing has been done/);
    expect(describeState("SUCCEEDED").terminal).toBe(true);
    expect(describeState("OUTCOME_UNKNOWN").terminal).toBe(false);
  });
});
