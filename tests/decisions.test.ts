import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  auditEvents,
  connectorAccounts,
  executions,
  mcpClients,
  mcpGrants,
  proposalVersions,
  proposals,
  users,
} from "@/db/schema";
import { DecisionError, decideProposal, onProposalApproved } from "@/server/decisions";
import { editProposal } from "@/server/edits";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import {
  acceptInvitation,
  changeMemberRole,
  createWorkspace,
  inviteMember,
} from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}
async function join(ownerId: string, wsId: string, role: "approver" | "member" | "viewer") {
  const email = `d${Math.random()}@example.test`;
  const id = await user(email);
  const { url } = await inviteMember(ownerId, wsId, email, role);
  await acceptInvitation(id, url.split("/invite/")[1]!);
  return id;
}

async function setup() {
  const owner = await user(`dc${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "Decisions");
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
  const approver = await join(owner, ws.id, "approver");
  const member = await join(owner, ws.id, "member");
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
  const decide = (
    decision: "approve" | "deny" | "cancel",
    over: Partial<Parameters<typeof decideProposal>[0]> = {},
  ) =>
    decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: p.proposalId,
      decision,
      expectedVersion: 1,
      ...over,
    });
  const stateOf = async () =>
    (await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId)))[0]!.state;
  return { owner, approver, member, ws, p, decide, stateOf, principal };
}

describe("approve", () => {
  it("approves the reviewed version, records who decided, and executes nothing itself", async () => {
    const s = await setup();
    expect(await s.decide("approve")).toEqual({
      status: "approved",
      state: "APPROVED",
      version: 1,
    });
    expect(await s.stateOf()).toBe("APPROVED");
    const rows = await getDb()
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.proposalId, s.p.proposalId));
    expect(rows).toMatchObject([{ decision: "approve", decidedByUserId: s.approver }]);
    const [v] = await getDb()
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, s.p.proposalId));
    expect(rows[0]!.proposalVersionId).toBe(v!.id);
    expect(await getDb().select().from(executions)).toHaveLength(0);
    const audit = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, s.p.proposalId));
    expect(audit.map((a) => a.action)).toContain("proposal.approved");
  });

  it("is idempotent under repeated and concurrent clicks: one approval, existing state returned", async () => {
    const s = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => s.decide("approve")));
    expect(results.filter((r) => r.status === "approved")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_approved")).toHaveLength(7);
    expect(
      await getDb()
        .select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.proposalId, s.p.proposalId)),
    ).toHaveLength(1);
  });

  it("notifies the executor exactly once", async () => {
    const s = await setup();
    const seen: string[] = [];
    const off = onProposalApproved(({ proposalId }) => void seen.push(proposalId));
    await Promise.all(Array.from({ length: 4 }, () => s.decide("approve")));
    off();
    expect(seen).toEqual([s.p.proposalId]);
  });

  it("refuses to approve a version the reviewer did not see (edit after opening)", async () => {
    const s = await setup();
    await editProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: s.p.proposalId,
      expectedVersion: 1,
      args: { owner: "acme", repo: "platform", title: "Changed", body: "B" },
    });
    await expect(s.decide("approve", { expectedVersion: 1 })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await s.stateOf()).toBe("PENDING_APPROVAL");
    expect((await s.decide("approve", { expectedVersion: 2 })).version).toBe(2);
    const versions = await getDb()
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, s.p.proposalId));
    const approval = (
      await getDb()
        .select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.decision, "approve"))
    ).find((d) => d.proposalId === s.p.proposalId)!;
    expect(versions.find((v) => v.id === approval.proposalVersionId)!.version).toBe(2);
  });

  it("enforces roles and separation of duties", async () => {
    const s = await setup();
    await expect(s.decide("approve", { actorId: s.member })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(s.decide("approve", { actorId: s.owner })).rejects.toMatchObject({
      code: "policy_denied",
    }); // owner requested it
    const stranger = await user(`x${Math.random()}@example.test`);
    await expect(s.decide("approve", { actorId: stranger })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await s.stateOf()).toBe("PENDING_APPROVAL");
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", {
      allowSelfApproval: true,
    });
    expect((await s.decide("approve", { actorId: s.owner })).status).toBe("approved");
  });

  it("re-checks policy at decision time", async () => {
    const s = await setup();
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", { enabled: false });
    const err = await s.decide("approve").catch((e) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.details.reasons.map((r: { code: string }) => r.code)).toContain(
      "capability_disabled",
    );
  });

  it("detects content changed behind the application's back and refuses to approve it", async () => {
    const s = await setup();
    // Simulate raw-database tampering by bypassing the immutability trigger for this transaction.
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`alter table proposal_versions disable trigger proposal_versions_immutable`,
      );
      await tx.execute(
        sql`update proposal_versions set args = jsonb_set(args, '{title}', '"Send secrets"') where proposal_id = ${s.p.proposalId}`,
      );
      await tx.execute(
        sql`alter table proposal_versions enable trigger proposal_versions_immutable`,
      );
    });
    await expect(s.decide("approve")).rejects.toMatchObject({ code: "integrity" });
    expect(await s.stateOf()).toBe("PENDING_APPROVAL");
  });

  it("cannot approve expired, denied or otherwise decided proposals", async () => {
    const s = await setup();
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, s.p.proposalId));
    await expect(s.decide("approve")).rejects.toMatchObject({ code: "not_pending" });
    expect(await s.stateOf()).toBe("EXPIRED");
    const t = await setup();
    await t.decide("deny");
    await expect(t.decide("approve")).rejects.toMatchObject({ code: "not_pending" });
  });

  it("stops an approver whose role was removed", async () => {
    const s = await setup();
    await changeMemberRole(s.owner, s.ws.id, s.approver, "viewer");
    await expect(s.decide("approve")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("deny and cancel", () => {
  it("denies with an optional reason, terminally, and repeats are harmless", async () => {
    const s = await setup();
    expect((await s.decide("deny", { reason: "Wrong repository" })).status).toBe("denied");
    expect((await s.decide("deny")).status).toBe("already_denied");
    expect(await s.stateOf()).toBe("DENIED");
    const [d] = await getDb()
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.proposalId, s.p.proposalId));
    expect(d).toMatchObject({ decision: "deny", reason: "Wrong repository" });
    await expect(s.decide("cancel")).rejects.toMatchObject({ code: "not_pending" });
  });

  it("lets the requester cancel their own request but not a plain member cancel someone else's", async () => {
    const s = await setup();
    await expect(s.decide("cancel", { actorId: s.member })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await s.decide("cancel", { actorId: s.owner })).status).toBe("canceled");
    expect(await s.stateOf()).toBe("CANCELED");
  });

  it("can cancel an approved-but-not-yet-executing proposal, never an executing one", async () => {
    const s = await setup();
    await s.decide("approve");
    expect((await s.decide("cancel")).status).toBe("canceled");
    const t = await setup();
    await t.decide("approve");
    await getDb()
      .update(proposals)
      .set({ state: "EXECUTING" })
      .where(eq(proposals.id, t.p.proposalId));
    await expect(t.decide("cancel")).rejects.toMatchObject({ code: "not_pending" });
  });

  it("lets only one of concurrent conflicting decisions win", async () => {
    const s = await setup();
    const results = await Promise.allSettled([
      s.decide("approve"),
      s.decide("deny"),
      s.decide("approve"),
      s.decide("deny"),
    ]);
    const wins = results.filter(
      (r) =>
        r.status === "fulfilled" && !(r.value as { status: string }).status.startsWith("already"),
    );
    expect(wins).toHaveLength(1);
    expect(["APPROVED", "DENIED"]).toContain(await s.stateOf());
    expect(
      await getDb()
        .select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.proposalId, s.p.proposalId)),
    ).toHaveLength(1);
  });

  it("hides other workspaces' proposals", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      decideProposal({
        actorId: b.approver,
        workspaceId: b.ws.id,
        proposalId: a.p.proposalId,
        decision: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
