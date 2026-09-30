import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "@/db/client";
import { auditEvents, executions, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import { connectAccount } from "@/server/connectors";
import {
  createAuthorizationCode,
  createGrant,
  exchangeAuthorizationCode,
  getClient,
  pkceChallenge,
  registerClient,
} from "@/server/mcp-oauth";
import { updateCapabilityPolicy } from "@/server/policy";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGithub, type FakeGithubOptions } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup(gh: FakeGithubOptions = {}, scopes = ["repo"]) {
  const fake = fakeGithub(gh);
  setTransportOverride("github", fake.sf);
  const email = `gp${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "GH Propose");
  await connectAccount({
    workspaceId: ws.id,
    actorId: u!.id,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: scopes,
    credentials: { accessToken: fake.token },
  });
  await updateCapabilityPolicy(u!.id, ws.id, "github.propose_issue", { enabled: true });

  const reg = await registerClient({
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"],
  });
  const client = (await getClient(reg.client_id))!;
  const grant = await createGrant({
    clientDbId: client.id,
    userId: u!.id,
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
  const propose = (args: Record<string, unknown>) =>
    mcp.callTool({ name: "github.propose_issue", arguments: args });
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
  return { u: u!.id, ws, fake, propose, text };
}

describe("github.propose_issue", () => {
  it("creates a pending proposal after read-only checks, and never writes to GitHub", async () => {
    const s = await setup();
    const r = await s.propose({
      owner: "Acme",
      repo: "Platform",
      title: "Handle failed webhook retries",
      body: "Details",
      labels: ["bug"],
    });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as any).state).toBe("PENDING_APPROVAL");
    expect(s.fake.requests.map((q) => q.method)).toEqual(expect.arrayContaining(["GET"]));
    expect(s.fake.requests.every((q) => q.method === "GET")).toBe(true);
    expect(s.fake.requests.some((q) => q.path.includes("/issues"))).toBe(false);
    expect(s.fake.issues).toHaveLength(0);
    expect(await getDb().select().from(executions)).toHaveLength(0);
    const audit = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, (r.structuredContent as any).proposal_id));
    expect(audit.find((a) => a.action === "proposal.created")!.detail).toMatchObject({
      destination_check: "ok",
    });
  });

  it("rejects a repository the account cannot see, with an actionable message", async () => {
    const s = await setup();
    const r = await s.propose({ owner: "acme", repo: "ghost", title: "T" });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/not found, or the connected GitHub account cannot see it/);
    expect(s.text(r)).toMatch(/Nothing was proposed/);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });

  it("rejects archived repositories and repositories with issues disabled", async () => {
    const s = await setup({
      repos: [
        { owner: "acme", name: "old", archived: true },
        { owner: "acme", name: "wiki-only", has_issues: false },
      ],
    });
    expect(s.text(await s.propose({ owner: "acme", repo: "old", title: "T" }))).toMatch(/archived/);
    expect(s.text(await s.propose({ owner: "acme", repo: "wiki-only", title: "T" }))).toMatch(
      /Issues are disabled/,
    );
  });

  it("rejects a private repository when the connection is public-only", async () => {
    const s = await setup(
      { repos: [{ owner: "acme", name: "priv", private: true }], scopes: "public_repo" },
      ["public_repo"],
    );
    const r = await s.propose({ owner: "acme", repo: "priv", title: "T" });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/only has access to public repositories/);
  });

  it("only allows labels when the connected identity can apply them", async () => {
    const s = await setup({ repos: [{ owner: "acme", name: "platform" }] });
    // Re-point the fixture so this repo reports read-only permissions.
    const noPush = fakeGithub({ repos: [{ owner: "acme", name: "platform" }] });
    const orig = noPush.fetchImpl;
    const readOnly: typeof fetch = async (i, init) => {
      const res = await orig(i, init);
      if (new URL(String(i)).pathname === "/repos/acme/platform") {
        const body = await res.json();
        return Response.json({ ...body, permissions: { pull: true, push: false, triage: false } });
      }
      return res;
    };
    const { createSafeFetch } = await import("@/connectors/transport");
    setTransportOverride(
      "github",
      createSafeFetch({
        allowedOrigins: ["https://api.github.com"],
        fetchImpl: readOnly,
        sleep: async () => {},
      }),
    );

    const withLabels = await s.propose({
      owner: "acme",
      repo: "platform",
      title: "T",
      labels: ["bug"],
    });
    expect(withLabels.isError).toBe(true);
    expect(s.text(withLabels)).toMatch(/cannot apply labels/);
    const without = await s.propose({ owner: "acme", repo: "platform", title: "T" });
    expect(without.isError).toBeFalsy();
  });

  it("still accepts the proposal when GitHub is unreachable, recording the check as unverified", async () => {
    const s = await setup({ failures: { "/repos/": 503 } });
    const r = await s.propose({ owner: "acme", repo: "platform", title: "T" });
    expect(r.isError).toBeFalsy();
    const audit = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, (r.structuredContent as any).proposal_id));
    expect(audit.find((a) => a.action === "proposal.created")!.detail).toMatchObject({
      destination_check: "unverified",
    });
  });

  it("rejects a revoked credential rather than queueing something that can never run", async () => {
    const s = await setup({ token: "the-real-token" });
    setTransportOverride("github", fakeGithub({ token: "something-else" }).sf); // GitHub no longer accepts the stored token
    const r = await s.propose({ owner: "acme", repo: "platform", title: "T" });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/needs to be reconnected/);
  });

  it("validates arguments before contacting GitHub at all", async () => {
    const s = await setup();
    const r = await s.propose({ owner: "acme/evil", repo: "platform", title: "T" });
    expect(r.isError).toBe(true);
    expect(s.fake.requests).toHaveLength(0);
  });

  it("respects workspace repository policy before contacting GitHub", async () => {
    const s = await setup();
    const { setResourceRule } = await import("@/server/policy");
    await setResourceRule(s.u, s.ws.id, {
      kind: "github_repo",
      value: "acme/allowed",
      effect: "allow",
    });
    const r = await s.propose({ owner: "acme", repo: "platform", title: "T" });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/allowed list/);
    expect(s.fake.requests).toHaveLength(0);
  });
});
