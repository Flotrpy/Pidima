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
import { fakeGithub, type FakeGithubOptions } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

/**
 * Fixture-based end-to-end scenarios: a real MCP client speaks to the real gateway over the real
 * Streamable HTTP handler and OAuth tokens; only GitHub itself is a fixture. These do NOT replace
 * the live-provider and real-Claude acceptance tests described in docs/testing.md.
 */
async function world(gh: FakeGithubOptions = {}) {
  const fake = fakeGithub(gh);
  setTransportOverride("github", fake.sf);
  const ownerEmail = `e2e${Math.random()}@example.test`;
  const owner = await (async () => (
    await signInAs(ownerEmail),
    (await getDb().select().from(users).where(eq(users.email, ownerEmail)))[0]!.id
  ))();
  const ws = await createWorkspace(owner, "E2E");
  await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: fake.token },
  });
  await updateCapabilityPolicy(owner, ws.id, "github.propose_issue", { enabled: true });
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
  const issueArgs = {
    owner: "acme",
    repo: "platform",
    title: "Handle failed webhook retries",
    body: "Retries are dropped after the third failure.",
    labels: ["bug"],
  };
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

describe("GitHub end to end: Claude proposes, a person decides, the issue is created once", () => {
  it("happy path with a human edit", async () => {
    const stop = startExecutor();
    try {
      const w = await world();
      expect((await w.claude.listTools()).tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["github.propose_issue", "action.get_status"]),
      );

      // 1. Claude proposes. GitHub is only read.
      const prop = await w.call("github.propose_issue", w.issueArgs);
      expect(prop.isError).toBe(false);
      const id = prop.out.proposal_id as string;
      expect(w.fake.issues).toHaveLength(0);
      expect((await w.call("action.get_status", { proposal_id: id })).out).toMatchObject({
        state: "PENDING_APPROVAL",
        terminal: false,
      });

      // 2. A person reviews the exact action, then edits it.
      const before = await getProposalDetail(w.approver, w.ws.id, id);
      expect(before).toMatchObject({
        destination: "acme/platform",
        state: "PENDING_APPROVAL",
        version: 1,
      });
      await editProposal({
        actorId: w.approver,
        workspaceId: w.ws.id,
        proposalId: id,
        expectedVersion: 1,
        args: { ...w.issueArgs, title: "Retries dropped after third webhook failure" },
        reason: "More precise",
      });
      expect((await w.call("action.get_status", { proposal_id: id })).out).toMatchObject({
        edited_by_human: true,
        version: 2,
      });

      // 3. Approving the stale version is refused; approving the reviewed one executes exactly once.
      await expect(w.decide(id, "approve", 1)).rejects.toMatchObject({ code: "conflict" });
      expect(w.fake.issues).toHaveLength(0);
      await w.decide(id, "approve", 2);
      expect(w.fake.issues).toHaveLength(1);
      expect(w.fake.issues[0]).toMatchObject({
        title: "Retries dropped after third webhook failure",
        owner: "acme",
        repo: "platform",
      });

      // 4. Claude sees the verified result; the receipt records who did what.
      const status = await w.call("action.get_status", { proposal_id: id });
      expect(status.out).toMatchObject({
        state: "SUCCEEDED",
        terminal: true,
        execution: { state: "SUCCEEDED", result_url: "https://github.com/acme/platform/issues/1" },
      });
      const [receipt] = await getReceiptsForProposal(w.owner, w.ws.id, id);
      expect(receipt!.body).toMatchObject({
        finalState: "SUCCEEDED",
        humanEdits: { count: 1 },
        decision: { outcome: "approved" },
        execution: { result: { url: "https://github.com/acme/platform/issues/1" } },
      });
    } finally {
      stop();
    }
  });

  it("denial creates nothing and tells Claude so", async () => {
    const stop = startExecutor();
    try {
      const w = await world();
      const id = (await w.call("github.propose_issue", w.issueArgs)).out.proposal_id as string;
      await w.decide(id, "deny");
      expect(w.fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      const s = await w.call("action.get_status", { proposal_id: id });
      expect(s.out).toMatchObject({ state: "DENIED", terminal: true });
      expect(s.out.status_text).toMatch(/Nothing was done/);
      expect((await getReceiptsForProposal(w.owner, w.ws.id, id))[0]!.body.finalState).toBe(
        "DENIED",
      );
    } finally {
      stop();
    }
  });

  it("prevents duplicates: retried proposals and repeated approvals still create one issue", async () => {
    const stop = startExecutor();
    try {
      const w = await world();
      const first = await w.call("github.propose_issue", {
        ...w.issueArgs,
        client_request_id: "req-1",
      });
      const retry = await w.call("github.propose_issue", {
        ...w.issueArgs,
        client_request_id: "req-1",
      });
      expect(retry.out.proposal_id).toBe(first.out.proposal_id);
      const id = first.out.proposal_id as string;
      await Promise.all([
        w.decide(id, "approve"),
        w.decide(id, "approve"),
        w.decide(id, "approve"),
      ]);
      expect(w.fake.issues).toHaveLength(1);
      expect(
        await getDb().select().from(executions).where(eq(executions.proposalId, id)),
      ).toHaveLength(1);
      expect((await w.call("action.list_recent", {})).out.count).toBe(1);
    } finally {
      stop();
    }
  });

  it.each([
    [
      "GitHub rejects the credential",
      { failures: { "/repos/acme/platform/issues": 401 } },
      "FAILED",
      /reconnect/i,
    ],
    [
      "the repository vanished",
      { failures: { "/repos/acme/platform/issues": 404 } },
      "FAILED",
      /no longer accessible/i,
    ],
    [
      "GitHub is down when writing",
      { failures: { "/repos/acme/platform/issues": 503 } },
      "OUTCOME_UNKNOWN",
      /verify/i,
    ],
  ] as const)("reports a provider failure honestly: %s", async (_n, opts, state, text) => {
    const stop = startExecutor();
    try {
      const w = await world(opts);
      const id = (await w.call("github.propose_issue", w.issueArgs)).out.proposal_id as string;
      await w.decide(id, "approve");
      const s = await w.call("action.get_status", { proposal_id: id });
      expect(s.out.state).toBe(state);
      expect(s.out.status_text).toMatch(text);
      expect(s.out.status_text).not.toMatch(/completed/i);
      expect(w.fake.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      expect(w.fake.issues).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("an expired proposal cannot be approved or executed", async () => {
    const stop = startExecutor();
    try {
      const w = await world();
      const id = (await w.call("github.propose_issue", w.issueArgs)).out.proposal_id as string;
      await getDb()
        .update(proposals)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(proposals.id, id));
      await expect(w.decide(id, "approve")).rejects.toMatchObject({ code: "not_pending" });
      expect(w.fake.issues).toHaveLength(0);
      expect((await w.call("action.get_status", { proposal_id: id })).out).toMatchObject({
        state: "EXPIRED",
        terminal: true,
      });
    } finally {
      stop();
    }
  });
});
