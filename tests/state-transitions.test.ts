import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents, connectorAccounts, proposals, users } from "@/db/schema";
import { ALL_STATES, allowedPairs } from "@/approvals/state-machine";
import { StaleStateError, applyTransition, InvalidTransitionError } from "@/server/transitions";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function proposal(state: (typeof ALL_STATES)[number] = "PENDING_APPROVAL") {
  const email = `t${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Transitions");
  const [c] = await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId: ws.id,
      provider: "github",
      externalAccountId: `${Math.random()}`,
      displayName: "gh",
      connectedByUserId: u!.id,
    })
    .returning();
  const [p] = await getDb()
    .insert(proposals)
    .values({
      workspaceId: ws.id,
      capability: "github.propose_issue",
      connectorAccountId: c!.id,
      clientLabel: "Claude",
      correlationId: "c",
      state,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return p!;
}

const stateOf = async (id: string) =>
  (await getDb().select().from(proposals).where(eq(proposals.id, id)))[0]!.state;

describe("server-enforced transitions", () => {
  it("applies a legal transition and audits it", async () => {
    const p = await proposal();
    expect(await applyTransition(p.id, "approve", { actor: { type: "user", id: "u1" } })).toEqual({
      from: "PENDING_APPROVAL",
      to: "APPROVED",
    });
    expect(await stateOf(p.id)).toBe("APPROVED");
    const events = await getDb().select().from(auditEvents).where(eq(auditEvents.subjectId, p.id));
    expect(events.map((e) => e.action)).toEqual(["proposal.approve"]);
  });

  it("rejects an illegal event without changing state", async () => {
    const p = await proposal("DENIED");
    await expect(applyTransition(p.id, "approve")).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await stateOf(p.id)).toBe("DENIED");
  });

  it("lets exactly one of many concurrent decisions win", async () => {
    const p = await proposal();
    const results = await Promise.allSettled([
      ...Array.from({ length: 5 }, () => applyTransition(p.id, "approve")),
      ...Array.from({ length: 5 }, () => applyTransition(p.id, "deny")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(
        [StaleStateError, InvalidTransitionError].some(
          (E) => (r as PromiseRejectedResult).reason instanceof E,
        ),
      ).toBe(true);
    }
  });

  it("is backed by a database guard that matches the table exactly", async () => {
    const allowed = new Set(allowedPairs().map(([a, b]) => `${a}>${b}`));
    let checked = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue;
        const p = await proposal(from);
        const attempt = getDb().update(proposals).set({ state: to }).where(eq(proposals.id, p.id));
        if (allowed.has(`${from}>${to}`)) await expect(attempt).resolves.toBeDefined();
        else await expect(attempt).rejects.toThrow(/illegal proposal transition|Failed query/);
        checked++;
      }
    }
    expect(checked).toBe(ALL_STATES.length * (ALL_STATES.length - 1));
  }, 60_000);
});
