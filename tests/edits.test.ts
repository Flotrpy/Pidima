import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  auditEvents,
  connectorAccounts,
  mcpClients,
  mcpGrants,
  proposalVersions,
  proposals,
  users,
} from "@/db/schema";
import { diffArgs } from "@/approvals/diff";
import { EditError, editProposal } from "@/server/edits";
import { getProposalDetail } from "@/server/inbox";
import { setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { listVersions } from "@/server/versions";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function join(ownerId: string, wsId: string, role: "approver" | "member" | "viewer") {
  const email = `e${Math.random()}@example.test`;
  const id = await user(email);
  const { url } = await inviteMember(ownerId, wsId, email, role);
  await acceptInvitation(id, url.split("/invite/")[1]!);
  return id;
}

async function setup() {
  const owner = await user(`ed${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "Edits");
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
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const original = {
    owner: "acme",
    repo: "platform",
    title: "Handle failed webhook retries",
    body: "line one\nline two",
    labels: ["bug"],
  };
  const p = await createProposal({ principal, capability: "github.propose_issue", args: original });
  const edit = (args: unknown, over: Partial<Parameters<typeof editProposal>[0]> = {}) =>
    editProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: p.proposalId,
      expectedVersion: 1,
      args,
      ...over,
    });
  return { owner, approver, ws, p, original, edit };
}

describe("human edits", () => {
  it("appends an immutable version, keeps the AI's version intact and leaves the proposal pending", async () => {
    const s = await setup();
    const r = await s.edit(
      { ...s.original, title: "Handle webhook retry failures", body: "line one\nline three" },
      { reason: "Clearer title" },
    );
    expect(r.version).toBe(2);

    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, s.p.proposalId));
    expect(p).toMatchObject({ state: "PENDING_APPROVAL", currentVersion: 2 });
    const vs = await listVersions(s.p.proposalId);
    expect(vs.map((v) => [v.version, v.authorType])).toEqual([
      [2, "human"],
      [1, "ai"],
    ]);
    expect(vs[0]!.authorUserId).toBe(s.approver);
    expect(vs[1]!.args).toMatchObject({
      title: "Handle failed webhook retries",
      body: "line one\nline two",
    });
    expect(vs[0]!.bindingHash).not.toBe(vs[1]!.bindingHash);

    const decisions = await getDb()
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.proposalId, s.p.proposalId));
    expect(decisions).toMatchObject([
      { decision: "edit", decidedByUserId: s.approver, reason: "Clearer title" },
    ]);
    const audit = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, s.p.proposalId));
    expect(audit.map((a) => a.action)).toContain("proposal.edited");
    expect(JSON.stringify(audit)).not.toContain("line three");
  });

  it("shows the reviewer a version history and a diff from the AI's original", async () => {
    const s = await setup();
    await s.edit({ ...s.original, body: "line one\nline three", labels: ["bug", "api"] });
    const d = await getProposalDetail(s.approver, s.ws.id, s.p.proposalId);
    expect(d.version).toBe(2);
    expect(d.versions.map((v) => [v.version, v.authorType, v.status])).toEqual([
      [2, "human", "current"],
      [1, "ai", "superseded"],
    ]);
    expect(d.versions[0]!.authorName).toBeTruthy();
    const v1 = (await listVersions(s.p.proposalId)).at(-1)!;
    const diff = diffArgs(v1.args as Record<string, unknown>, d.args);
    expect(diff.map((x) => x.key)).toEqual(["body", "labels"]);
  });

  it("supports repeated edits and each one supersedes the last", async () => {
    const s = await setup();
    await s.edit({ ...s.original, title: "v2 title" });
    await s.edit({ ...s.original, title: "v3 title" }, { expectedVersion: 2 });
    const vs = await listVersions(s.p.proposalId);
    expect(vs.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(
      (await getProposalDetail(s.approver, s.ws.id, s.p.proposalId)).versions.map((v) => v.status),
    ).toEqual(["current", "superseded", "superseded"]);
  });

  it("rejects stale edits so one reviewer cannot overwrite another's", async () => {
    const s = await setup();
    await s.edit({ ...s.original, title: "first" });
    await expect(s.edit({ ...s.original, title: "second" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("lets exactly one of several concurrent edits win", async () => {
    const s = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => s.edit({ ...s.original, title: `concurrent ${i}` })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const vs = await getDb()
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, s.p.proposalId));
    expect(vs).toHaveLength(2);
  });

  it("refuses no-op edits and invalid content, storing nothing", async () => {
    const s = await setup();
    await expect(s.edit({ ...s.original })).rejects.toMatchObject({ code: "no_changes" });
    const bad = await s.edit({ ...s.original, title: "" }).catch((e) => e);
    expect(bad).toBeInstanceOf(EditError);
    expect(bad.code).toBe("invalid_arguments");
    expect(bad.details.issues[0].path).toBe("title");
    expect(await listVersions(s.p.proposalId)).toHaveLength(1);
  });

  it("requires authority to decide this type of action", async () => {
    const s = await setup();
    const member = await join(s.owner, s.ws.id, "member");
    const viewer = await join(s.owner, s.ws.id, "viewer");
    await expect(s.edit({ ...s.original, title: "x" }, { actorId: member })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(s.edit({ ...s.original, title: "x" }, { actorId: viewer })).rejects.toMatchObject({
      code: "forbidden",
    });
    const stranger = await user(`x${Math.random()}@example.test`);
    await expect(
      s.edit({ ...s.original, title: "x" }, { actorId: stranger }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("re-applies workspace policy to the edited destination", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "github_repo",
      value: "acme/platform",
      effect: "allow",
    });
    const err = await s.edit({ ...s.original, repo: "secrets" }).catch((e) => e);
    expect(err.code).toBe("policy_denied");
    expect(err.details.reasons[0].code).toBe("resource_not_allowed");
    expect(await listVersions(s.p.proposalId)).toHaveLength(1);
  });

  it("cannot edit proposals that are approved, decided or expired", async () => {
    for (const state of ["APPROVED", "DENIED", "EXPIRED"] as const) {
      const s = await setup();
      await getDb().update(proposals).set({ state }).where(eq(proposals.id, s.p.proposalId));
      await expect(s.edit({ ...s.original, title: "late" })).rejects.toMatchObject({
        code: "not_editable",
      });
    }
  });

  it("does not let an editor reach another workspace's proposal", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      editProposal({
        actorId: b.approver,
        workspaceId: b.ws.id,
        proposalId: a.p.proposalId,
        expectedVersion: 1,
        args: { ...a.original, title: "x" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
