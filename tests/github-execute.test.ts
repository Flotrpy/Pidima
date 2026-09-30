import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  auditEvents,
  connectorAccounts,
  executionAttempts,
  executions,
  mcpClients,
  mcpGrants,
  proposals,
  users,
} from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { issueMarker, withMarker } from "@/connectors/github/runtime";
import { connectAccount, testConnector } from "@/server/connectors";
import { revokeConnector } from "@/server/credentials";
import { decideProposal } from "@/server/decisions";
import {
  executeApprovedProposal,
  reconcileUnknownOutcomes,
  runExecutionMaintenance,
  startExecutor,
} from "@/server/executor";
import { idempotencyKeyFor, recoverStuckExecutions } from "@/server/execution-claim";
import {
  changeMemberRole,
  acceptInvitation,
  createWorkspace,
  inviteMember,
} from "@/server/workspaces";
import { setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { listVersions } from "@/server/versions";
import { signInAs } from "./auth-helpers";
import { fakeGithub, type FakeGithubOptions } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup(gh: FakeGithubOptions = {}) {
  const fake = fakeGithub(gh);
  setTransportOverride("github", fake.sf);
  const email = `gx${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Exec");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: u!.id,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: fake.token },
  });
  await updateCapabilityPolicy(u!.id, ws.id, "github.propose_issue", { enabled: true });
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
      userId: u!.id,
      workspaceId: ws.id,
      scopes: ["proposals:create"],
    })
    .returning();
  const aemail = `ap${Math.random()}@example.test`;
  await signInAs(aemail);
  const [a] = await getDb().select().from(users).where(eq(users.email, aemail));
  const { url } = await inviteMember(u!.id, ws.id, aemail, "approver");
  await acceptInvitation(a!.id, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: u!.id,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const args = {
    owner: "acme",
    repo: "platform",
    title: "Handle failed webhook retries",
    body: "Line one\nLine two",
    labels: ["bug", "api"],
  };
  const propose = (over: Record<string, unknown> = {}) =>
    createProposal({ principal, capability: "github.propose_issue", args: { ...args, ...over } });
  const approve = (id: string) =>
    decideProposal({
      actorId: a!.id,
      workspaceId: ws.id,
      proposalId: id,
      decision: "approve",
      expectedVersion: 1,
    });
  const stateOf = async (id: string) =>
    (await getDb().select().from(proposals).where(eq(proposals.id, id)))[0]!.state;
  const exec = async (id: string) =>
    (await getDb().select().from(executions).where(eq(executions.proposalId, id)))[0]!;
  const posts = () => fake.requests.filter((r) => r.method === "POST");
  const ready = async (over: Record<string, unknown> = {}) => {
    const p = await propose(over);
    await approve(p.proposalId);
    return p.proposalId;
  };
  return {
    fake,
    owner: u!.id,
    approver: a!.id,
    ws,
    c,
    args,
    propose,
    approve,
    stateOf,
    exec,
    posts,
    ready,
  };
}

describe("approved GitHub issue execution", () => {
  it("creates exactly the approved issue once and records the provider result", async () => {
    const s = await setup();
    const id = await s.ready();
    expect(s.posts()).toHaveLength(0); // approval alone contacts nothing
    const r = await executeApprovedProposal(id);
    expect(r).toMatchObject({ status: "done", outcome: "succeeded" });

    expect(s.posts()).toHaveLength(1);
    const issue = s.fake.issues[0]!;
    expect(issue).toMatchObject({
      owner: "acme",
      repo: "platform",
      title: "Handle failed webhook retries",
      labels: ["api", "bug"],
    });
    const key = idempotencyKeyFor((await listVersions(id))[0]!.id);
    expect(issue.body).toBe(withMarker("Line one\nLine two", key));
    expect(issue.body).toContain(issueMarker(key));

    expect(await s.stateOf(id)).toBe("SUCCEEDED");
    const e = await s.exec(id);
    expect(e).toMatchObject({
      state: "SUCCEEDED",
      providerResult: {
        providerId: "1",
        url: "https://github.com/acme/platform/issues/1",
        repository: "acme/platform",
      },
    });
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.subjectId, id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["execution.claimed", "execution.succeeded"]),
    );
    expect(JSON.stringify(audit)).not.toContain("Line one");
  });

  it("uses the approved credential and sends no unexpected fields", async () => {
    const s = await setup();
    await executeApprovedProposal(await s.ready());
    const post = s.posts()[0]!;
    expect(post.headers.get("authorization")).toBe(`Bearer ${s.fake.token}`);
    expect(Object.keys(post.body as object).sort()).toEqual(["body", "labels", "title"]);
    expect(post.path).toBe("/repos/acme/platform/issues");
  });

  it("creates only ONE issue under concurrent executors and repeated approval clicks", async () => {
    const s = await setup();
    const p = await s.propose();
    await Promise.all(Array.from({ length: 6 }, () => s.approve(p.proposalId)));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => executeApprovedProposal(p.proposalId)),
    );
    expect(results.filter((r) => r.status === "done")).toHaveLength(1);
    expect(s.fake.issues).toHaveLength(1);
    expect(
      await getDb().select().from(executions).where(eq(executions.proposalId, p.proposalId)),
    ).toHaveLength(1);
    // A late duplicate trigger (e.g. the maintenance sweep) also does nothing.
    expect((await executeApprovedProposal(p.proposalId)).status).toBe("skipped");
    expect(s.fake.issues).toHaveLength(1);
  });

  it("does nothing for proposals that were never approved, or were denied or canceled", async () => {
    const s = await setup();
    const pending = await s.propose();
    expect((await executeApprovedProposal(pending.proposalId)).status).toBe("skipped");
    const denied = await s.propose();
    await decideProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: denied.proposalId,
      decision: "deny",
      expectedVersion: 1,
    });
    expect((await executeApprovedProposal(denied.proposalId)).status).toBe("skipped");
    expect(s.fake.issues).toHaveLength(0);
    expect(s.posts()).toHaveLength(0);
  });

  it("runs automatically after approval once the executor is started", async () => {
    const s = await setup();
    const stop = startExecutor();
    try {
      const p = await s.propose();
      await s.approve(p.proposalId);
      expect(s.fake.issues).toHaveLength(1);
      expect(await s.stateOf(p.proposalId)).toBe("SUCCEEDED");
    } finally {
      stop();
    }
  });
});

describe("re-validation immediately before execution", () => {
  it("fails without any write when workspace policy changed after approval", async () => {
    const s = await setup();
    const id = await s.ready();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/platform",
      effect: "block",
    });
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("FAILED");
    expect(await s.exec(id)).toMatchObject({ state: "FAILED", errorCategory: "policy_changed" });
    expect(s.posts()).toHaveLength(0);
  });

  it("fails without any write when the capability was disabled", async () => {
    const s = await setup();
    const id = await s.ready();
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: false });
    await executeApprovedProposal(id);
    expect((await s.exec(id)).errorCategory).toBe("policy_changed");
    expect(s.posts()).toHaveLength(0);
  });

  it("fails without any write when the connector was revoked after approval", async () => {
    const s = await setup();
    const id = await s.ready();
    await revokeConnector(s.c.id);
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("FAILED");
    expect((await s.exec(id)).errorCategory).toBe("auth_expired");
    expect(s.posts()).toHaveLength(0);
  });

  it("fails without any write when the approver lost the right to approve", async () => {
    const s = await setup();
    const id = await s.ready();
    await changeMemberRole(s.owner, s.ws.id, s.approver, "viewer");
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("FAILED");
    expect(s.posts()).toHaveLength(0);
  });

  it("fails without any write when the repository is no longer valid (archived)", async () => {
    const s = await setup();
    const id = await s.ready();
    // GitHub now reports the repo archived.
    setTransportOverride(
      "github",
      fakeGithub({ repos: [{ owner: "acme", name: "platform", archived: true }] }).sf,
    );
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("FAILED");
    expect(await s.exec(id)).toMatchObject({ errorCategory: "destination_inaccessible" });
    expect(s.posts()).toHaveLength(0);
  });

  it("refuses to run an approved proposal that expired, and never posts", async () => {
    const s = await setup();
    const id = await s.ready();
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, id));
    expect(await executeApprovedProposal(id)).toEqual({ status: "skipped", reason: "expired" });
    expect(await s.stateOf(id)).toBe("EXPIRED");
    expect(s.posts()).toHaveLength(0);
  });

  it("refuses content that was altered after approval (integrity)", async () => {
    const s = await setup();
    const id = await s.ready();
    const { sql } = await import("drizzle-orm");
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`alter table proposal_versions disable trigger proposal_versions_immutable`,
      );
      await tx.execute(
        sql`update proposal_versions set args = jsonb_set(args, '{title}', '"Something else"') where proposal_id = ${id}`,
      );
      await tx.execute(
        sql`alter table proposal_versions enable trigger proposal_versions_immutable`,
      );
    });
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("FAILED");
    expect(s.posts()).toHaveLength(0);
  });
});

describe("provider outcomes", () => {
  const cases: [string, FakeGithubOptions, string, string][] = [
    [
      "a rejected credential",
      { failures: { "/repos/acme/platform/issues": 401 } },
      "FAILED",
      "auth_expired",
    ],
    [
      "missing permission",
      { failures: { "/repos/acme/platform/issues": 403 } },
      "FAILED",
      "scope_missing",
    ],
    [
      "a repository that disappeared",
      { failures: { "/repos/acme/platform/issues": 404 } },
      "FAILED",
      "destination_inaccessible",
    ],
    [
      "a rate limit",
      { failures: { "/repos/acme/platform/issues": 429 } },
      "FAILED",
      "rate_limited",
    ],
    [
      "content GitHub rejects",
      { failures: { "/repos/acme/platform/issues": 422 } },
      "FAILED",
      "provider_rejected",
    ],
  ];
  it.each(cases)(
    "records %s as a confirmed failure with the right category",
    async (_n, opts, state, category) => {
      const s = await setup(opts);
      const id = await s.ready();
      await executeApprovedProposal(id);
      expect(await s.stateOf(id)).toBe(state);
      expect((await s.exec(id)).errorCategory).toBe(category);
      expect(s.posts()).toHaveLength(1); // one attempt, never retried
      expect(s.fake.issues).toHaveLength(0);
    },
  );

  it("treats a 5xx on the write as UNKNOWN, never as failure, and does not retry", async () => {
    const s = await setup({ failures: { "/repos/acme/platform/issues": 503 } });
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
    expect(s.posts()).toHaveLength(1);
    expect((await s.exec(id)).errorCategory).toBe("verification_required");
    await runExecutionMaintenance();
    expect(s.posts()).toHaveLength(1); // maintenance must not re-dispatch
  });

  it("treats a lost response after GitHub created the issue as UNKNOWN, then reconciles to SUCCEEDED via the marker", async () => {
    const s = await setup({ dropIssueResponse: true });
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(s.fake.issues).toHaveLength(1); // GitHub really did create it
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
    expect(s.posts()).toHaveLength(1);

    // GitHub's list endpoint sees the issue; the marker proves it is ours.
    const orig = s.fake.fetchImpl;
    const listing: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/acme/platform/issues" && (init?.method ?? "GET") === "GET") {
        return Response.json(
          s.fake.issues.map((i) => ({
            id: 900000 + i.number,
            number: i.number,
            html_url: `https://github.com/acme/platform/issues/${i.number}`,
            body: i.body,
          })),
        );
      }
      return orig(input, init);
    };
    const { createSafeFetch } = await import("@/connectors/transport");
    setTransportOverride(
      "github",
      createSafeFetch({
        allowedOrigins: ["https://api.github.com"],
        fetchImpl: listing,
        sleep: async () => {},
      }),
    );

    expect(await reconcileUnknownOutcomes()).toMatchObject({ resolved: 1 });
    expect(await s.stateOf(id)).toBe("SUCCEEDED");
    expect(await s.exec(id)).toMatchObject({
      state: "SUCCEEDED",
      providerResult: { url: "https://github.com/acme/platform/issues/1", reconciled: true },
    });
    expect(s.posts()).toHaveLength(1); // still exactly one write
    expect((await reconcileUnknownOutcomes()).resolved).toBe(0); // idempotent
  });

  it("leaves an unknown outcome unknown when the lookup finds nothing (a miss proves nothing)", async () => {
    const s = await setup({ failures: { "/repos/acme/platform/issues": 503 } });
    const id = await s.ready();
    await executeApprovedProposal(id);
    const r = await reconcileUnknownOutcomes();
    expect(r.resolved).toBe(0);
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
  });

  it("marks a timed-out write unknown rather than failed", async () => {
    const { DISPATCH_DEADLINE_MS } = await import("@/server/executor");
    expect(DISPATCH_DEADLINE_MS).toBeGreaterThan(0);
    const s = await setup();
    const id = await s.ready();
    // Simulate a transport-level timeout on the write itself.
    const { createSafeFetch } = await import("@/connectors/transport");
    const slow: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST")
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return s.fake.fetchImpl(input, init);
    };
    setTransportOverride(
      "github",
      createSafeFetch({
        allowedOrigins: ["https://api.github.com"],
        fetchImpl: slow,
        sleep: async () => {},
      }),
    );
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
    expect((await s.exec(id)).errorDetail).toMatch(/did not respond in time/);
  });
});

describe("crash recovery", () => {
  it("never re-dispatches a claim whose worker died after sending, and fails one that died before", async () => {
    const s = await setup();
    const sent = await s.ready();
    // Worker died after "dispatch attempted".
    const { claimExecution, recordDispatchAttempt } = await import("@/server/execution-claim");
    const c1 = (await claimExecution(sent, "dead-worker"))!;
    await recordDispatchAttempt(c1.executionId);
    const notSent = await s.ready({ title: "second" });
    const c2 = (await claimExecution(notSent, "dead-worker"))!;
    await getDb()
      .update(executions)
      .set({ startedAt: new Date(Date.now() - 600_000) })
      .where(eq(executions.proposalId, sent));
    await getDb()
      .update(executions)
      .set({ startedAt: new Date(Date.now() - 600_000) })
      .where(eq(executions.proposalId, notSent));
    await recoverStuckExecutions();
    expect(await s.stateOf(sent)).toBe("OUTCOME_UNKNOWN");
    expect(await s.stateOf(notSent)).toBe("FAILED");
    expect(s.posts()).toHaveLength(0);
    expect(c2.executionId).toBeTruthy();
    expect(
      await getDb()
        .select()
        .from(executionAttempts)
        .where(eq(executionAttempts.executionId, c1.executionId)),
    ).toHaveLength(1);
  });

  it("maintenance picks up approved proposals that no listener executed", async () => {
    const s = await setup();
    const id = await s.ready();
    const r = await runExecutionMaintenance();
    expect(r.dispatched).toBeGreaterThanOrEqual(1);
    expect(await s.stateOf(id)).toBe("SUCCEEDED");
    expect(s.fake.issues).toHaveLength(1);
    await runExecutionMaintenance();
    expect(s.fake.issues).toHaveLength(1);
  });
});

describe("safety of the runtime itself", () => {
  it("never exposes a delete, edit or close operation", async () => {
    const { GithubClient } = await import("@/connectors/github/client");
    const names = Object.getOwnPropertyNames(GithubClient.prototype);
    expect(names.filter((n) => /delete|remove|close|update|patch|merge|transfer/i.test(n))).toEqual(
      [],
    );
  });

  it("the health test is still read-only after the write path exists", async () => {
    const s = await setup();
    await testConnector(s.owner, s.c.id);
    expect(s.posts()).toHaveLength(0);
  });
});
