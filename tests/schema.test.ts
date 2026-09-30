import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resetTestDatabase, testDb } from "./helpers";
import * as s from "@/db/schema";

const t = testDb();
afterAll(() => t.pool.end());

async function seed() {
  const userId = randomUUID();
  await t.db.insert(s.users).values({ id: userId, name: "U", email: `${userId}@x.test` });
  const [ws] = await t.db
    .insert(s.workspaces)
    .values({ name: "W", slug: randomUUID(), createdByUserId: userId })
    .returning();
  const [conn] = await t.db
    .insert(s.connectorAccounts)
    .values({
      workspaceId: ws!.id,
      provider: "github",
      externalAccountId: "1",
      displayName: "gh",
      connectedByUserId: userId,
    })
    .returning();
  const [p] = await t.db
    .insert(s.proposals)
    .values({
      workspaceId: ws!.id,
      capability: "github.propose_issue",
      connectorAccountId: conn!.id,
      clientLabel: "Claude",
      correlationId: "c1",
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  const [v] = await t.db
    .insert(s.proposalVersions)
    .values({
      proposalId: p!.id,
      version: 1,
      args: { title: "t" },
      argsHash: "h",
      bindingHash: "b",
      destination: "a/b",
      authorType: "ai",
    })
    .returning();
  return { userId, ws: ws!, conn: conn!, p: p!, v: v! };
}

describe("core schema guarantees", () => {
  beforeAll(resetTestDatabase);

  it("rejects updates and deletes on append-only tables", async () => {
    const { v } = await seed();
    await expect(
      t.pool.query("update proposal_versions set destination='x' where id=$1", [v.id]),
    ).rejects.toThrow(/append-only/);
    await expect(t.pool.query("delete from proposal_versions where id=$1", [v.id])).rejects.toThrow(
      /append-only/,
    );
  });

  it("allows retention deletes only when explicitly opted in", async () => {
    const { v } = await seed();
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local app.retention_purge = 'on'");
      await expect(
        c.query("delete from proposal_versions where id=$1", [v.id]),
      ).resolves.toBeTruthy();
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("allows only one execution per proposal version", async () => {
    const { p, v } = await seed();
    const row = { proposalVersionId: v.id, proposalId: p.id, claimedBy: "a", idempotencyKey: "k" };
    await t.db.insert(s.executions).values(row);
    await expect(t.db.insert(s.executions).values({ ...row, claimedBy: "b" })).rejects.toThrow();
  });

  it("allows only one approval per version", async () => {
    const { p, v, userId } = await seed();
    const d = { proposalId: p.id, proposalVersionId: v.id, decidedByUserId: userId };
    await t.db.insert(s.approvalDecisions).values({ ...d, decision: "approve" });
    await expect(
      t.db.insert(s.approvalDecisions).values({ ...d, decision: "approve" }),
    ).rejects.toThrow();
  });

  it("allows a single original receipt but multiple corrections", async () => {
    const { p, v, ws } = await seed();
    const r = {
      workspaceId: ws.id,
      proposalId: p.id,
      proposalVersionId: v.id,
      finalState: "SUCCEEDED" as const,
      body: {},
    };
    await t.db.insert(s.receipts).values(r);
    await expect(t.db.insert(s.receipts).values(r)).rejects.toThrow();
    await t.db.insert(s.receipts).values({ ...r, kind: "correction" });
    await t.db.insert(s.receipts).values({ ...r, kind: "correction" });
  });
});
