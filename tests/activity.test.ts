import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents, users } from "@/db/schema";
import {
  ACTIVITY_PAGE,
  describeAction,
  listActivity,
  purgeExpiredAuditEvents,
} from "@/server/activity";
import { recordAudit } from "@/server/audit";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup() {
  const email = `ac${Math.random()}@example.test`;
  await signInAs(email, "Maya Chen");
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  return { owner, ws: await createWorkspace(owner, "Activity") };
}

describe("activity timeline", () => {
  it("lists workspace events newest first with human wording and resolved actor names", async () => {
    const s = await setup();
    await recordAudit({
      workspaceId: s.ws.id,
      actorType: "mcp_client",
      action: "proposal.created",
      subjectType: "proposal",
      subjectId: "p1",
      correlationId: "corr-1",
    });
    await recordAudit({
      workspaceId: s.ws.id,
      actorType: "system",
      action: "execution.succeeded",
      correlationId: "corr-1",
    });
    const { items } = await listActivity(s.owner, s.ws.id);
    expect(items[0]).toMatchObject({ action: "execution.succeeded", actor: "System" });
    expect(items.find((i) => i.action === "proposal.created")).toMatchObject({
      actor: "AI client",
      correlationId: "corr-1",
    });
    expect(items.find((i) => i.action === "workspace.created")!.actor).toBe("Maya Chen");
    expect(describeAction("proposal.approved")).toBe("Approved");
    expect(describeAction("something.new_thing")).toBe("something new thing");
  });

  it("filters by category and by correlation ID", async () => {
    const s = await setup();
    await recordAudit({
      workspaceId: s.ws.id,
      actorType: "user",
      actorId: s.owner,
      action: "policy.rule_set",
      correlationId: "c-a",
    });
    await recordAudit({
      workspaceId: s.ws.id,
      actorType: "user",
      actorId: s.owner,
      action: "connector.tested",
      correlationId: "c-b",
    });
    expect((await listActivity(s.owner, s.ws.id, "policy")).items.map((i) => i.action)).toEqual([
      "policy.rule_set",
    ]);
    expect((await listActivity(s.owner, s.ws.id, "connectors")).items.map((i) => i.action)).toEqual(
      ["connector.tested"],
    );
    expect((await listActivity(s.owner, s.ws.id, "all", undefined, "c-b")).items).toHaveLength(1);
  });

  it("redacts detail on write and again on read, so content and credentials never surface", async () => {
    const s = await setup();
    await recordAudit({
      workspaceId: s.ws.id,
      actorType: "system",
      action: "proposal.created",
      detail: {
        destination: "acme/platform",
        body: "SECRET BODY",
        accessToken: "gho_abc",
        nested: { authorization: "Bearer x", ok: 1 },
      },
    });
    const { items } = await listActivity(s.owner, s.ws.id, "proposals");
    const json = JSON.stringify(items[0]!.detail);
    expect(json).toContain("acme/platform");
    expect(json).not.toMatch(/SECRET BODY|gho_abc|Bearer x/);
    // Even a row written with raw secrets (bypassing recordAudit) is scrubbed when read.
    await getDb()
      .insert(auditEvents)
      .values({
        workspaceId: s.ws.id,
        actorType: "system",
        action: "proposal.denied",
        detail: { password: "hunter2", text: "leak" },
      });
    expect(
      JSON.stringify((await listActivity(s.owner, s.ws.id, "proposals")).items[0]!.detail),
    ).not.toMatch(/hunter2|leak/);
  });

  it("paginates newest first without repeats and ignores forged cursors", async () => {
    const s = await setup();
    for (let i = 0; i < ACTIVITY_PAGE + 5; i++)
      await recordAudit({
        workspaceId: s.ws.id,
        actorType: "system",
        action: "policy.rule_set",
        detail: { i },
      });
    const p1 = await listActivity(s.owner, s.ws.id, "policy");
    const p2 = await listActivity(s.owner, s.ws.id, "policy", p1.nextCursor!);
    expect(p1.items).toHaveLength(ACTIVITY_PAGE);
    expect(p2.items).toHaveLength(5);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(ACTIVITY_PAGE + 5);
    expect((await listActivity(s.owner, s.ws.id, "policy", "garbage")).items).toHaveLength(
      ACTIVITY_PAGE,
    );
  }, 60_000);

  it("never skips rows that differ only by microseconds (regression: ms-precision cursors)", async () => {
    const s = await setup();
    const total = ACTIVITY_PAGE + 10;
    await getDb()
      .execute(sql`insert into audit_events (workspace_id, actor_type, action, created_at)
      select ${s.ws.id}::uuid, 'system', 'policy.rule_set', timestamptz '2026-03-01 12:00:00.123000+00' + (g * interval '1 microsecond') from generate_series(1, ${total}) g`);
    const p1 = await listActivity(s.owner, s.ws.id, "policy");
    const p2 = await listActivity(s.owner, s.ws.id, "policy", p1.nextCursor!);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(total);
    expect(p2.nextCursor).toBeNull();
  });

  it("is workspace-scoped, and requires the activity permission (viewers may read)", async () => {
    const s = await setup();
    const other = await setup();
    await recordAudit({ workspaceId: other.ws.id, actorType: "system", action: "policy.rule_set" });
    expect((await listActivity(s.owner, s.ws.id, "policy")).items).toHaveLength(0);
    await expect(listActivity(other.owner, s.ws.id)).rejects.toMatchObject({ code: "not_found" });
    const v = `vw${Math.random()}@example.test`;
    await signInAs(v);
    const viewer = (await getDb().select().from(users).where(eq(users.email, v)))[0]!.id;
    const { url } = await inviteMember(s.owner, s.ws.id, v, "viewer");
    await acceptInvitation(viewer, url.split("/invite/")[1]!);
    expect((await listActivity(viewer, s.ws.id)).items.length).toBeGreaterThan(0);
  });
});

describe("audit retention", () => {
  it("purges only events older than the window, only through the opt-in path", async () => {
    const s = await setup();
    const old = new Date(Date.now() - 500 * 86_400_000);
    await getDb().insert(auditEvents).values({
      workspaceId: s.ws.id,
      actorType: "system",
      action: "policy.rule_set",
      createdAt: old,
    });
    await recordAudit({ workspaceId: s.ws.id, actorType: "system", action: "policy.rule_removed" });
    await expect(
      getDb().delete(auditEvents).where(eq(auditEvents.workspaceId, s.ws.id)),
    ).rejects.toThrow(); // append-only
    expect(await purgeExpiredAuditEvents(400)).toBeGreaterThanOrEqual(1);
    const left = (await listActivity(s.owner, s.ws.id, "policy")).items.map((i) => i.action);
    expect(left).toEqual(["policy.rule_removed"]);
    await expect(purgeExpiredAuditEvents(3)).rejects.toThrow(/at least 30 days/);
  });
});
