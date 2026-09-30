import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, users } from "@/db/schema";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import {
  mcpResourceUrl,
  protectedResourceMetadataUrl,
  protectedResourceMetadata,
} from "@/mcp/metadata";
import { checkGatewayReachable, getClaudeStatus } from "@/server/claude-status";
import {
  createAuthorizationCode,
  createGrant,
  exchangeAuthorizationCode,
  getClient,
  pkceChallenge,
  registerClient,
} from "@/server/mcp-oauth";
import { callProposeTool } from "@/server/mcp-tools";
import { updateCapabilityPolicy } from "@/server/policy";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const okFetch: typeof fetch = async () =>
  new Response(JSON.stringify(protectedResourceMetadata()), { status: 200 });

describe("gateway reachability check", () => {
  it("passes only when the public discovery document names this resource", async () => {
    expect((await checkGatewayReachable(okFetch)).reachable).toBe(true);
    expect(
      (
        await checkGatewayReachable(
          async () => new Response(JSON.stringify({ resource: "https://other.test/mcp" })),
        )
      ).reachable,
    ).toBe(false);
    expect(
      (await checkGatewayReachable(async () => new Response("no", { status: 502 }))).detail,
    ).toMatch(/502/);
    expect(
      (
        await checkGatewayReachable(async () => {
          throw new TypeError("fetch failed");
        })
      ).detail,
    ).toMatch(/could not be reached/);
  });
});

describe("Claude connection status keeps four facts separate", () => {
  it("progresses honestly from nothing to a received proposal", async () => {
    const email = `cs${Math.random()}@example.test`;
    await signInAs(email);
    const [u] = await getDb().select().from(users).where(eq(users.email, email));
    const ws = await createWorkspace(u!.id, "Status");
    const status = () => getClaudeStatus(u!.id, ws.id, okFetch);

    let s = await status();
    expect(s.endpointUrl).toBe(mcpResourceUrl());
    expect([
      s.gateway.reachable,
      s.authorized.done,
      s.activityObserved.done,
      s.proposalReceived.done,
    ]).toEqual([true, false, false, false]);

    const reg = await registerClient({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
    });
    const client = (await getClient(reg.client_id))!;
    const grant = await createGrant({
      clientDbId: client.id,
      userId: u!.id,
      workspaceId: ws.id,
      scopes: ["proposals:create"],
    });
    s = await status();
    // Authorized, but nothing observed: must not read as "connected".
    expect([
      s.authorized.done,
      s.authorized.clientNames,
      s.activityObserved.done,
      s.proposalReceived.done,
    ]).toEqual([true, ["Claude"], false, false]);

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
    const res = await handleMcpRequest(
      new Request(mcpResourceUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      authenticateBearer,
      protectedResourceMetadataUrl(),
    );
    expect(res.status).toBe(200);
    s = await status();
    expect([s.activityObserved.done, s.proposalReceived.done]).toEqual([true, false]);

    await getDb()
      .insert(connectorAccounts)
      .values({
        workspaceId: ws.id,
        provider: "github",
        externalAccountId: "1",
        displayName: "gh",
        connectedByUserId: u!.id,
        grantedScopes: ["repo"],
      });
    await updateCapabilityPolicy(u!.id, ws.id, "github.propose_issue", { enabled: true });
    const principal = {
      grantId: grant.id,
      userId: u!.id,
      workspaceId: ws.id,
      clientLabel: "Claude",
      scopes: ["proposals:create"],
    };
    expect(
      (
        await callProposeTool(principal, "github.propose_issue", {
          owner: "a",
          repo: "b",
          title: "t",
        })
      ).isError,
    ).toBe(false);
    s = await status();
    expect([s.proposalReceived.done, s.proposalReceived.count]).toEqual([true, 1]);
  });

  it("requires permission to view AI client status", async () => {
    const email = `cs${Math.random()}@example.test`;
    await signInAs(email);
    const [u] = await getDb().select().from(users).where(eq(users.email, email));
    const ws = await createWorkspace(u!.id, "Status2");
    const stranger = `st${Math.random()}@example.test`;
    await signInAs(stranger);
    const [x] = await getDb().select().from(users).where(eq(users.email, stranger));
    await expect(getClaudeStatus(x!.id, ws.id, okFetch)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
