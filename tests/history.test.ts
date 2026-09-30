import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, mcpClients, mcpGrants, proposals, users } from "@/db/schema";
import { decideProposal } from "@/server/decisions";
import { claimExecution, finalizeExecution } from "@/server/execution-claim";
import { HISTORY_PAGE, listHistory } from "@/server/receipts";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, sweepExpired, type Principal } from "@/server/proposals";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";
import { setTransportOverride } from "@/connectors/transport";
import { fakeGithub } from "./fake-github";

beforeAll(resetTestDatabase);

async function setup() {
  setTransportOverride("github", fakeGithub().sf);
  const email = `hi${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "History");
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
  await updateCapabilityPolicy(owner, ws.id, "github.propose_issue", { enabled: true });
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
  const aemail = `ap${Math.random()}@example.test`;
  await signInAs(aemail);
  const approver = (await getDb().select().from(users).where(eq(users.email, aemail)))[0]!.id;
  const { url } = await inviteMember(owner, ws.id, aemail, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const make = async (title: string) =>
    (
      await createProposal({
        principal,
        capability: "github.propose_issue",
        args: { owner: "acme", repo: "platform", title, body: "b" },
      })
    ).proposalId;
  const decide = (id: string, d: "approve" | "deny") =>
    decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: id,
      decision: d,
      expectedVersion: 1,
    });
  return { owner, approver, ws, make, decide };
}

describe("history", () => {
  it("lists settled items by outcome with recovery guidance, and excludes open work", async () => {
    const s = await setup();
    const ok = await s.make("ok");
    await s.decide(ok, "approve");
    await finalizeExecution((await claimExecution(ok, "w"))!, {
      status: "succeeded",
      providerId: "1",
      url: "https://x/1",
    });
    const bad = await s.make("bad");
    await s.decide(bad, "approve");
    await finalizeExecution((await claimExecution(bad, "w"))!, {
      status: "failed",
      category: "destination_inaccessible",
      message: "gone",
    });
    const unk = await s.make("unk");
    await s.decide(unk, "approve");
    await finalizeExecution((await claimExecution(unk, "w"))!, {
      status: "unknown",
      reason: "timeout",
    });
    const den = await s.make("den");
    await s.decide(den, "deny");
    const exp = await s.make("exp");
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, exp));
    await sweepExpired();
    await s.make("still open");

    const all = await listHistory(s.owner, s.ws.id);
    expect(all.items.map((i) => i.finalState).sort()).toEqual([
      "DENIED",
      "EXPIRED",
      "FAILED",
      "OUTCOME_UNKNOWN",
      "SUCCEEDED",
    ]);
    expect((await listHistory(s.owner, s.ws.id, "failed")).items[0]!.recovery).toMatchObject({
      title: expect.stringMatching(/no longer accessible/i),
    });
    expect((await listHistory(s.owner, s.ws.id, "unknown")).items[0]!.recovery!.recovery).toMatch(
      /Check the destination directly/,
    );
    expect((await listHistory(s.owner, s.ws.id, "completed")).items).toHaveLength(1);
    expect((await listHistory(s.owner, s.ws.id, "denied")).items[0]).toMatchObject({
      decidedBy: expect.any(String),
      summary: "Create GitHub issue in acme/platform",
    });
  });

  it("shows only the latest receipt once an unknown outcome is corrected", async () => {
    const s = await setup();
    const id = await s.make("x");
    await s.decide(id, "approve");
    await finalizeExecution((await claimExecution(id, "w"))!, { status: "unknown", reason: "t" });
    expect((await listHistory(s.owner, s.ws.id)).items.map((i) => i.finalState)).toEqual([
      "OUTCOME_UNKNOWN",
    ]);
    const { reconcileToSuccess } = await import("@/server/reconcile-support");
    const { executions } = await import("@/db/schema");
    const [p] = await getDb().select().from(proposals).where(eq(proposals.id, id));
    const [e] = await getDb().select().from(executions).where(eq(executions.proposalId, id));
    await reconcileToSuccess(p!, e!.id, {
      status: "succeeded",
      providerId: "1",
      url: "https://x/1",
    });
    const after = await listHistory(s.owner, s.ws.id);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ finalState: "SUCCEEDED", kind: "correction" });
  });

  it("paginates without repeats and ignores forged cursors", async () => {
    const s = await setup();
    for (let i = 0; i < HISTORY_PAGE + 3; i++) await s.decide(await s.make(`d${i}`), "deny");
    const p1 = await listHistory(s.owner, s.ws.id);
    const p2 = await listHistory(s.owner, s.ws.id, "all", p1.nextCursor!);
    expect(p1.items).toHaveLength(HISTORY_PAGE);
    expect(p2.items).toHaveLength(3);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.receiptId)).size).toBe(HISTORY_PAGE + 3);
    expect((await listHistory(s.owner, s.ws.id, "all", "garbage")).items).toHaveLength(
      HISTORY_PAGE,
    );
  }, 90_000);

  it("is workspace-scoped and readable by viewers, but not by strangers", async () => {
    const s = await setup();
    const other = await setup();
    await s.decide(await s.make("mine"), "deny");
    await other.decide(await other.make("theirs"), "deny");
    expect((await listHistory(s.owner, s.ws.id)).items).toHaveLength(1);
    await expect(listHistory(other.owner, s.ws.id)).rejects.toMatchObject({ code: "not_found" });
    const vemail = `vw${Math.random()}@example.test`;
    await signInAs(vemail);
    const viewer = (await getDb().select().from(users).where(eq(users.email, vemail)))[0]!.id;
    const { url } = await inviteMember(s.owner, s.ws.id, vemail, "viewer");
    await acceptInvitation(viewer, url.split("/invite/")[1]!);
    expect((await listHistory(viewer, s.ws.id)).items).toHaveLength(1);
  });
});
