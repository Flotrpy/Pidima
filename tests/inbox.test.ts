import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, mcpClients, mcpGrants, proposals, users } from "@/db/schema";
import {
  FILTERS,
  PAGE_SIZE,
  countsByFilter,
  getOperationalSummary,
  getProposalDetail,
  listProposals,
} from "@/server/inbox";
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

async function setup() {
  const owner = await user(`in${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "Inbox");
  const [conn] = await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId: ws.id,
      provider: "github",
      externalAccountId: `${Math.random()}`,
      displayName: "Acme GitHub",
      connectedByUserId: owner,
      grantedScopes: ["repo"],
    })
    .returning();
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
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const make = (title: string, extra: Record<string, unknown> = {}) =>
    createProposal({
      principal,
      capability: "github.propose_issue",
      args: { owner: "acme", repo: "platform", title, body: "Body of " + title, ...extra },
    });
  return { owner, ws, conn: conn!, principal, make };
}

describe("inbox listing", () => {
  it("lists the queue newest first with destination and requester", async () => {
    const s = await setup();
    await s.make("first");
    await new Promise((r) => setTimeout(r, 5));
    await s.make("second");
    const { items, nextCursor } = await listProposals(s.owner, s.ws.id, "needs_review");
    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      destination: "acme/platform",
      clientLabel: "Claude",
      state: "PENDING_APPROVAL",
      title: "GitHub issue",
    });
    expect(items[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(items[1]!.createdAt.getTime());
  });

  it("filters by state group", async () => {
    const s = await setup();
    const a = await s.make("a");
    const b = await s.make("b");
    await getDb().update(proposals).set({ state: "DENIED" }).where(eq(proposals.id, a.proposalId));
    await getDb()
      .update(proposals)
      .set({ state: "CANCELED" })
      .where(eq(proposals.id, b.proposalId));
    expect((await listProposals(s.owner, s.ws.id, "needs_review")).items).toHaveLength(0);
    expect((await listProposals(s.owner, s.ws.id, "denied")).items).toHaveLength(2);
    const counts = await countsByFilter(s.owner, s.ws.id);
    expect(counts).toMatchObject({ needs_review: 0, denied: 2, completed: 0 });
    expect(Object.keys(counts)).toEqual(Object.keys(FILTERS));
  });

  it("paginates with a stable keyset cursor and never repeats or skips rows", async () => {
    const s = await setup();
    const total = PAGE_SIZE + 7;
    for (let i = 0; i < total; i++) await s.make(`p${i}`);
    const first = await listProposals(s.owner, s.ws.id, "needs_review");
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(first.nextCursor).toBeTruthy();
    const second = await listProposals(s.owner, s.ws.id, "needs_review", first.nextCursor!);
    expect(second.items).toHaveLength(7);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(total);
  }, 60_000);

  it("ignores a malformed or forged cursor rather than failing", async () => {
    const s = await setup();
    await s.make("x");
    for (const bad of [
      "garbage",
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ t: "nope", id: "1" })).toString("base64url"),
    ]) {
      expect((await listProposals(s.owner, s.ws.id, "needs_review", bad)).items).toHaveLength(1);
    }
  });

  it("never shows another workspace's proposals, and hides the workspace from strangers", async () => {
    const a = await setup();
    const b = await setup();
    await a.make("secret");
    expect((await listProposals(b.owner, b.ws.id, "needs_review")).items).toHaveLength(0);
    await expect(listProposals(b.owner, a.ws.id, "needs_review")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lets viewers see receipts only, not the queue", async () => {
    const s = await setup();
    const email = `vw${Math.random()}@example.test`;
    const viewer = await user(email);
    const { url } = await inviteMember(s.owner, s.ws.id, email, "viewer");
    await acceptInvitation(viewer, url.split("/invite/")[1]!);
    await expect(listProposals(viewer, s.ws.id, "needs_review")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("review detail", () => {
  it("answers who, what, where, how long and what happens", async () => {
    const s = await setup();
    const r = await s.make("Handle failed webhook retries");
    const d = await getProposalDetail(s.owner, s.ws.id, r.proposalId);
    expect(d).toMatchObject({
      title: "GitHub issue",
      verb: "create a GitHub issue",
      clientLabel: "Claude",
      state: "PENDING_APPROVAL",
      destination: "acme/platform",
      version: 1,
    });
    expect(d.requestedBy).toBeTruthy();
    expect(d.connector).toMatchObject({
      displayName: "Acme GitHub",
      provider: "github",
      status: "active",
    });
    expect(d.requiredScopes).toEqual(["repo"]);
    expect(d.fields.find((f) => f.label === "Repository")).toMatchObject({
      value: "acme/platform",
      emphasis: true,
    });
    expect(d.fields.find((f) => f.label === "Body")?.value).toBe(
      "Body of Handle failed webhook retries",
    );
    expect(d.consequences[0]).toMatch(/acme\/platform/);
    expect(d.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(d.versions).toEqual([
      expect.objectContaining({ version: 1, authorType: "ai", status: "current" }),
    ]);
  });

  it("shows the complete body, never a truncated one", async () => {
    const s = await setup();
    const long = "line\n".repeat(5000);
    const r = await s.make("Long", { body: long });
    const d = await getProposalDetail(s.owner, s.ws.id, r.proposalId);
    expect((d.fields.find((f) => f.label === "Body")!.value as string).length).toBeGreaterThan(
      20_000,
    );
  });

  it("warns when content contains hidden text-direction controls", async () => {
    const s = await setup();
    const r = await s.make("Total: ‮0.001$", {});
    expect((await getProposalDetail(s.owner, s.ws.id, r.proposalId)).hiddenDirectionWarning).toBe(
      true,
    );
    const ok = await s.make("Plain");
    expect((await getProposalDetail(s.owner, s.ws.id, ok.proposalId)).hiddenDirectionWarning).toBe(
      false,
    );
  });

  it("explains why the reader cannot decide (self-approval by default)", async () => {
    const s = await setup();
    const r = await s.make("Mine");
    const d = await getProposalDetail(s.owner, s.ws.id, r.proposalId);
    expect(d.blockers.map((b) => b.code)).toContain("self_approval");
  });

  it("expires overdue proposals on read", async () => {
    const s = await setup();
    const r = await s.make("Late");
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, r.proposalId));
    expect((await getProposalDetail(s.owner, s.ws.id, r.proposalId)).state).toBe("EXPIRED");
  });

  it("treats other workspaces' and malformed IDs as not found", async () => {
    const a = await setup();
    const b = await setup();
    const r = await a.make("Private");
    await expect(getProposalDetail(b.owner, b.ws.id, r.proposalId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getProposalDetail(b.owner, a.ws.id, r.proposalId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getProposalDetail(a.owner, a.ws.id, "not-a-uuid")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      getProposalDetail(a.owner, a.ws.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("operational summary", () => {
  it("counts what needs attention and reports connector problems and expiring items", async () => {
    const s = await setup();
    const a = await s.make("a");
    await s.make("b");
    // Legal path only: the database guard rejects PENDING_APPROVAL -> FAILED.
    await getDb()
      .update(proposals)
      .set({ state: "APPROVED" })
      .where(eq(proposals.id, a.proposalId));
    await getDb().update(proposals).set({ state: "FAILED" }).where(eq(proposals.id, a.proposalId));
    const c = await s.make("expiring");
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() + 5 * 60_000) })
      .where(eq(proposals.id, c.proposalId));
    await getDb()
      .update(connectorAccounts)
      .set({ status: "needs_reauth" })
      .where(eq(connectorAccounts.id, s.conn.id));
    const sum = await getOperationalSummary(s.owner, s.ws.id);
    expect(sum).toMatchObject({
      needsReview: 2,
      failed: 1,
      executing: 0,
      outcomeUnknown: 0,
      connectorProblems: 1,
      lastVerifiedActivity: null,
      expiringSoon: 1,
    });
  });
});
