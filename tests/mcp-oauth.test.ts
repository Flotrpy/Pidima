import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "@/db/client";
import { mcpGrants, mcpTokens, users } from "@/db/schema";
import { POST as register } from "@/app/api/oauth/register/route";
import { POST as tokenEndpoint } from "@/app/api/oauth/token/route";
import { POST as revokeEndpoint } from "@/app/api/oauth/revoke/route";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import {
  createAuthorizationCode,
  createGrant,
  getClient,
  pkceChallenge,
  verifyAccessToken,
} from "@/server/mcp-oauth";
import { sha256 } from "@/server/tokens";
import {
  acceptInvitation,
  changeMemberRole,
  createWorkspace,
  inviteMember,
} from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const form = (o: Record<string, string>) =>
  new Request("http://localhost:3000/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(o).toString(),
  });

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function setup() {
  const owner = await user(`o${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "MCP");
  const reg = await register(
    new Request("http://localhost:3000/api/oauth/register", {
      method: "POST",
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    }),
  );
  const client = await reg.json();
  const dbClient = (await getClient(client.client_id))!;
  const grant = await createGrant({
    clientDbId: dbClient.id,
    userId: owner,
    workspaceId: ws.id,
    scopes: ["proposals:create", "proposals:read"],
  });
  const verifier = randomBytes(48).toString("base64url");
  const code = await createAuthorizationCode({
    grantId: grant.id,
    redirectUri: REDIRECT,
    codeChallenge: pkceChallenge(verifier),
    resource: mcpResourceUrl(),
  });
  return { owner, ws, client, grant, verifier, code };
}

const exchange = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, string> = {}) =>
  tokenEndpoint(
    form({
      grant_type: "authorization_code",
      client_id: s.client.client_id,
      code: s.code,
      redirect_uri: REDIRECT,
      code_verifier: s.verifier,
      ...over,
    }),
  );

describe("dynamic client registration", () => {
  const reg = (body: unknown) =>
    register(
      new Request("http://localhost:3000/api/oauth/register", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

  it("registers public PKCE clients", async () => {
    const res = await reg({
      client_name: "Claude",
      redirect_uris: [REDIRECT, "http://localhost:6274/cb"],
    });
    expect(res.status).toBe(201);
    const c = await res.json();
    expect(c.token_endpoint_auth_method).toBe("none");
    expect(c.client_id).toMatch(/^mcp_/);
  });

  it.each([
    ["javascript scheme", { redirect_uris: ["javascript:alert(1)"] }],
    ["plain http off-loopback", { redirect_uris: ["http://evil.test/cb"] }],
    ["fragment", { redirect_uris: ["https://a.test/cb#x"] }],
    ["none", { redirect_uris: [] }],
    [
      "confidential client",
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
    ],
    ["implicit grant", { redirect_uris: [REDIRECT], grant_types: ["implicit"] }],
  ])("rejects %s", async (_n, body) => {
    expect((await reg(body)).status).toBe(400);
  });
});

describe("authorization code + PKCE token endpoint", () => {
  it("issues audience-bound tokens that verify and drive a real MCP call", async () => {
    const s = await setup();
    const res = await exchange(s);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const t = await res.json();
    expect(t.token_type).toBe("Bearer");
    expect(t.scope).toBe("proposals:create proposals:read");

    const [row] = await getDb()
      .select()
      .from(mcpTokens)
      .where(eq(mcpTokens.tokenHash, sha256(t.access_token)));
    expect(row?.audience).toBe(mcpResourceUrl());
    expect(JSON.stringify(row)).not.toContain(t.access_token);

    const client = new Client({ name: "t", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpResourceUrl()), {
      requestInit: { headers: { authorization: `Bearer ${t.access_token}` } },
      fetch: (i, init) =>
        handleMcpRequest(
          new Request(i as string, init),
          authenticateBearer,
          protectedResourceMetadataUrl(),
        ),
    });
    await client.connect(transport);
    await client.close();
  });

  it("makes the code single-use, including under concurrency", async () => {
    const s = await setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => exchange(s)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await exchange(s)).status).toBe(400);
  });

  it("rejects a wrong verifier, redirect URI, client or resource", async () => {
    const wrongVerifier = await setup();
    expect(
      (await exchange(wrongVerifier, { code_verifier: randomBytes(48).toString("base64url") }))
        .status,
    ).toBe(400);
    const wrongRedirect = await setup();
    expect((await exchange(wrongRedirect, { redirect_uri: "https://evil.test/cb" })).status).toBe(
      400,
    );
    const other = await setup();
    const wrongClient = await setup();
    expect((await exchange(wrongClient, { client_id: other.client.client_id })).status).toBe(400);
    const wrongResource = await setup();
    const r = await exchange(wrongResource, { resource: "https://elsewhere.test/mcp" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_target");
  });

  it("refuses to mint codes for another resource or with a weak challenge", async () => {
    const s = await setup();
    await expect(
      createAuthorizationCode({
        grantId: s.grant.id,
        redirectUri: REDIRECT,
        codeChallenge: pkceChallenge(s.verifier),
        resource: "https://elsewhere.test/mcp",
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
    await expect(
      createAuthorizationCode({
        grantId: s.grant.id,
        redirectUri: REDIRECT,
        codeChallenge: "plain-verifier",
        resource: mcpResourceUrl(),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("expires codes", async () => {
    const s = await setup();
    const { mcpAuthorizationCodes } = await import("@/db/schema");
    await getDb()
      .update(mcpAuthorizationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await exchange(s)).status).toBe(400);
  });

  it("rejects unsupported grant types and non-form bodies", async () => {
    const s = await setup();
    expect(
      (await tokenEndpoint(form({ grant_type: "password", client_id: s.client.client_id }))).status,
    ).toBe(400);
    const json = await tokenEndpoint(
      new Request("http://localhost:3000/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(json.status).toBe(400);
  });
});

describe("refresh tokens and revocation", () => {
  it("rotates refresh tokens and treats replay of an old one as theft", async () => {
    const s = await setup();
    const first = await (await exchange(s)).json();
    const second = await (
      await tokenEndpoint(
        form({
          grant_type: "refresh_token",
          client_id: s.client.client_id,
          refresh_token: first.refresh_token,
        }),
      )
    ).json();
    expect(second.access_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const replay = await tokenEndpoint(
      form({
        grant_type: "refresh_token",
        client_id: s.client.client_id,
        refresh_token: first.refresh_token,
      }),
    );
    expect(replay.status).toBe(400);
    // The whole token family is now dead, including the freshly rotated pair.
    expect(await verifyAccessToken(second.access_token)).toBeNull();
    expect(
      (
        await tokenEndpoint(
          form({
            grant_type: "refresh_token",
            client_id: s.client.client_id,
            refresh_token: second.refresh_token,
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("does not let one client use another client's refresh token", async () => {
    const a = await setup();
    const b = await setup();
    const t = await (await exchange(a)).json();
    expect(
      (
        await tokenEndpoint(
          form({
            grant_type: "refresh_token",
            client_id: b.client.client_id,
            refresh_token: t.refresh_token,
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("revokes through the revocation endpoint and reports success for unknown tokens", async () => {
    const s = await setup();
    const t = await (await exchange(s)).json();
    expect(await verifyAccessToken(t.access_token)).not.toBeNull();
    const res = await revokeEndpoint(
      form({ client_id: s.client.client_id, token: t.refresh_token }),
    );
    expect(res.status).toBe(200);
    expect(await verifyAccessToken(t.access_token)).toBeNull();
    expect(
      (await revokeEndpoint(form({ client_id: s.client.client_id, token: "nope" }))).status,
    ).toBe(200);
  });
});

describe("bearer verification", () => {
  it("rejects expired tokens, tokens for another audience, and revoked grants", async () => {
    const s = await setup();
    const t = await (await exchange(s)).json();
    expect(await verifyAccessToken(t.access_token)).not.toBeNull();

    await getDb()
      .update(mcpTokens)
      .set({ audience: "https://elsewhere.test/mcp" })
      .where(eq(mcpTokens.tokenHash, sha256(t.access_token)));
    expect(await verifyAccessToken(t.access_token)).toBeNull();
    await getDb()
      .update(mcpTokens)
      .set({ audience: mcpResourceUrl(), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpTokens.tokenHash, sha256(t.access_token)));
    expect(await verifyAccessToken(t.access_token)).toBeNull();

    const s2 = await setup();
    const t2 = await (await exchange(s2)).json();
    await getDb()
      .update(mcpGrants)
      .set({ revokedAt: new Date() })
      .where(eq(mcpGrants.id, s2.grant.id));
    expect(await verifyAccessToken(t2.access_token)).toBeNull();
  });

  it("stops working when the granting user loses the right to connect clients", async () => {
    const s = await setup();
    const t = await (await exchange(s)).json();
    const email = `v${Math.random()}@example.test`;
    const viewer = await user(email);
    const { url } = await inviteMember(s.owner, s.ws.id, email, "member");
    await acceptInvitation(viewer, url.split("/invite/")[1]!);
    // Owner is downgraded to a role without clients.connect (a second owner keeps the workspace valid).
    await changeMemberRole(s.owner, s.ws.id, viewer, "owner");
    await changeMemberRole(viewer, s.ws.id, s.owner, "viewer");
    expect(await verifyAccessToken(t.access_token)).toBeNull();
  });

  it("returns 401 without echoing details for malformed or unknown bearer values", async () => {
    for (const h of [
      undefined,
      "Bearer",
      "Bearer short",
      "Basic abc",
      `Bearer ${"x".repeat(60)}`,
    ]) {
      const res = await handleMcpRequest(
        new Request(mcpResourceUrl(), {
          method: "POST",
          headers: h ? { authorization: h } : {},
          body: "{}",
        }),
        authenticateBearer,
        protectedResourceMetadataUrl(),
      );
      expect(res.status).toBe(401);
    }
  });

  it("only lets Owners and Members create grants", async () => {
    const s = await setup();
    const email = `vw${Math.random()}@example.test`;
    const v = await user(email);
    const { url } = await inviteMember(s.owner, s.ws.id, email, "viewer");
    await acceptInvitation(v, url.split("/invite/")[1]!);
    const c = (await getClient(s.client.client_id))!;
    await expect(
      createGrant({
        clientDbId: c.id,
        userId: v,
        workspaceId: s.ws.id,
        scopes: ["proposals:read"],
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(
      createGrant({ clientDbId: c.id, userId: s.owner, workspaceId: s.ws.id, scopes: [] }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });
});
