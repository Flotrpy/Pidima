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
import { decideProposal } from "@/server/decisions";
import {
  claimExecution,
  findUnclaimedApproved,
  finalizeExecution,
  idempotencyKeyFor,
  recordDispatchAttempt,
  recoverStuckExecutions,
} from "@/server/execution-claim";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function approved() {
  const owner = await user(`ex${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "Exec");
  await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId: ws.id,
      provider: "github",
      externalAccountId: `${Math.random()}`,
      displayName: "gh",
      connectedByUserId: owner,
      grantedScopes: ["repo"],
    });
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
      userId: owner,
      workspaceId: ws.id,
      scopes: ["proposals:create"],
    })
    .returning();
  await updateCapabilityPolicy(owner, ws.id, "github.propose_issue", { enabled: true });
  const email = `ap${Math.random()}@example.test`;
  const approver = await user(email);
  const { url } = await inviteMember(owner, ws.id, email, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const p = await createProposal({
    principal,
    capability: "github.propose_issue",
    args: { owner: "acme", repo: "platform", title: "T", body: "B" },
  });
  const approve = () =>
    decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: p.proposalId,
      decision: "approve",
      expectedVersion: 1,
    });
  return { owner, approver, ws, p, approve, id: p.proposalId };
}
const stateOf = async (id: string) =>
  (await getDb().select().from(proposals).where(eq(proposals.id, id)))[0]!.state;

describe("atomic execution claim", () => {
  it("claims an approved proposal, moving it to EXECUTING with a stable idempotency key", async () => {
    const s = await approved();
    await s.approve();
    const c = await claimExecution(s.id, "instance-a");
    expect(c).not.toBeNull();
    expect(c!.idempotencyKey).toBe(idempotencyKeyFor(c!.version.id));
    expect(c!.approvedByUserId).toBe(s.approver);
    expect(await stateOf(s.id)).toBe("EXECUTING");
    const [row] = await getDb().select().from(executions).where(eq(executions.proposalId, s.id));
    expect(row).toMatchObject({ state: "EXECUTING", claimedBy: "instance-a" });
  });

  it("lets exactly one of many concurrent workers claim, across simulated instances", async () => {
    const s = await approved();
    await s.approve();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => claimExecution(s.id, `instance-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await getDb().select().from(executions).where(eq(executions.proposalId, s.id)),
    ).toHaveLength(1);
  });

  it("refuses to claim anything that is not approved", async () => {
    const pending = await approved();
    expect(await claimExecution(pending.id, "a")).toBeNull();
    const denied = await approved();
    await decideProposal({
      actorId: denied.approver,
      workspaceId: denied.ws.id,
      proposalId: denied.id,
      decision: "deny",
      expectedVersion: 1,
    });
    expect(await claimExecution(denied.id, "a")).toBeNull();
    const canceled = await approved();
    await canceled.approve();
    await decideProposal({
      actorId: canceled.approver,
      workspaceId: canceled.ws.id,
      proposalId: canceled.id,
      decision: "cancel",
      expectedVersion: 1,
    });
    expect(await claimExecution(canceled.id, "a")).toBeNull();
    expect(await claimExecution("00000000-0000-0000-0000-000000000000", "a")).toBeNull();
  });

  it("will not claim a second time even after the first finished (replay)", async () => {
    const s = await approved();
    await s.approve();
    const c = (await claimExecution(s.id, "a"))!;
    await finalizeExecution(c, {
      status: "succeeded",
      providerId: "1",
      url: "https://github.com/acme/platform/issues/1",
    });
    expect(await claimExecution(s.id, "b")).toBeNull();
    expect(await stateOf(s.id)).toBe("SUCCEEDED");
  });

  it("keeps the database uniqueness guarantee even if the state machine is bypassed", async () => {
    const s = await approved();
    await s.approve();
    const c = (await claimExecution(s.id, "a"))!;
    await expect(
      getDb().insert(executions).values({
        proposalVersionId: c.version.id,
        proposalId: s.id,
        claimedBy: "rogue",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow();
  });
});

describe("finalizing results", () => {
  it("records success with provider identifiers", async () => {
    const s = await approved();
    await s.approve();
    const c = (await claimExecution(s.id, "a"))!;
    await recordDispatchAttempt(c.executionId);
    expect(
      await finalizeExecution(c, {
        status: "succeeded",
        providerId: "42",
        url: "https://x.test/42",
      }),
    ).toBe(true);
    const [e] = await getDb().select().from(executions).where(eq(executions.id, c.executionId));
    expect(e).toMatchObject({
      state: "SUCCEEDED",
      providerResult: { providerId: "42", url: "https://x.test/42" },
      errorCategory: null,
    });
    expect(e!.finishedAt).toBeInstanceOf(Date);
    const [a] = await getDb()
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.executionId, c.executionId));
    expect(a).toMatchObject({ outcome: "success" });
  });

  it("records a confirmed failure and an unknown outcome distinctly", async () => {
    const f = await approved();
    await f.approve();
    const fc = (await claimExecution(f.id, "a"))!;
    await finalizeExecution(fc, {
      status: "failed",
      category: "destination_inaccessible",
      message: "Repository not found",
    });
    expect(await stateOf(f.id)).toBe("FAILED");
    expect(
      (await getDb().select().from(executions).where(eq(executions.id, fc.executionId)))[0],
    ).toMatchObject({ errorCategory: "destination_inaccessible" });

    const u = await approved();
    await u.approve();
    const uc = (await claimExecution(u.id, "a"))!;
    await recordDispatchAttempt(uc.executionId);
    await finalizeExecution(uc, { status: "unknown", reason: "Timed out after sending" });
    expect(await stateOf(u.id)).toBe("OUTCOME_UNKNOWN");
    expect(
      (await getDb().select().from(executions).where(eq(executions.id, uc.executionId)))[0],
    ).toMatchObject({ state: "OUTCOME_UNKNOWN", errorCategory: "verification_required" });
  });

  it("finalizes only once: a late duplicate cannot overwrite the first outcome", async () => {
    const s = await approved();
    await s.approve();
    const c = (await claimExecution(s.id, "a"))!;
    const results = await Promise.all(
      [
        finalizeExecution(c, { status: "succeeded", providerId: "1" }),
        finalizeExecution(c, { status: "failed", category: "provider_rejected", message: "x" }),
        finalizeExecution(c, { status: "unknown", reason: "y" }),
      ].map((p) => p.catch(() => false)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const final = await stateOf(s.id);
    expect(["SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN"]).toContain(final);
    const [e] = await getDb().select().from(executions).where(eq(executions.id, c.executionId));
    expect(e!.state).toBe(final);
  });

  it("audits claim and result without content", async () => {
    const s = await approved();
    await s.approve();
    const c = (await claimExecution(s.id, "a"))!;
    await finalizeExecution(c, { status: "succeeded", providerId: "1" });
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.subjectId, s.id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["execution.claimed", "execution.succeeded"]),
    );
  });
});

describe("restart recovery", () => {
  const old = (executionId: string) =>
    getDb()
      .update(executions)
      .set({ startedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(executions.id, executionId));

  it("fails a claim that never dispatched, and marks a dispatched one unknown, never retrying either", async () => {
    const a = await approved();
    await a.approve();
    const ac = (await claimExecution(a.id, "dead"))!;
    await old(ac.executionId);

    const b = await approved();
    await b.approve();
    const bc = (await claimExecution(b.id, "dead"))!;
    await recordDispatchAttempt(bc.executionId);
    await old(bc.executionId);

    const r = await recoverStuckExecutions();
    expect(r.failedBeforeDispatch).toBeGreaterThanOrEqual(1);
    expect(r.unknown).toBeGreaterThanOrEqual(1);
    expect(await stateOf(a.id)).toBe("FAILED");
    expect(
      (await getDb().select().from(executions).where(eq(executions.id, ac.executionId)))[0],
    ).toMatchObject({ errorCategory: "failed_before_dispatch" });
    expect(await stateOf(b.id)).toBe("OUTCOME_UNKNOWN");
    expect(await claimExecution(a.id, "new")).toBeNull();
    expect(await claimExecution(b.id, "new")).toBeNull();
  });

  it("leaves recent executions alone", async () => {
    const s = await approved();
    await s.approve();
    await claimExecution(s.id, "live");
    await recoverStuckExecutions();
    expect(await stateOf(s.id)).toBe("EXECUTING");
  });

  it("finds approved proposals nobody has claimed", async () => {
    const s = await approved();
    await s.approve();
    expect(await findUnclaimedApproved()).toContain(s.id);
    await claimExecution(s.id, "a");
    expect(await findUnclaimedApproved()).not.toContain(s.id);
  });
});
