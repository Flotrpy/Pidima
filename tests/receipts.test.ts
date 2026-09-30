import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, proposals, receipts, users } from "@/db/schema";
import { argsHash } from "@/approvals/hashing";
import { createSafeFetch, setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { decideProposal } from "@/server/decisions";
import { editProposal } from "@/server/edits";
import { executeApprovedProposal, reconcileUnknownOutcomes } from "@/server/executor";
import {
  backfillMissingReceipts,
  getReceipt,
  getReceiptsForProposal,
  receiptNumber,
} from "@/server/receipts";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, sweepExpired, type Principal } from "@/server/proposals";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGithub, type FakeGithubOptions } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const SECRET_BODY = "CONFIDENTIAL-BODY-TEXT-777";
const TOKEN = "gho_test_token_123";

async function user(email: string, name?: string) {
  await signInAs(email, name);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function setup(gh: FakeGithubOptions = {}) {
  const fake = fakeGithub(gh);
  setTransportOverride("github", fake.sf);
  const owner = await user(`rc${Math.random()}@example.test`, "Maya Chen");
  const ws = await createWorkspace(owner, "Receipts HQ");
  await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "github",
    externalAccountId: "583231",
    displayName: "Acme Engineering GitHub",
    grantedScopes: ["repo"],
    credentials: { accessToken: TOKEN },
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
  const approver = await user(aemail, "Dev Patel");
  const { url } = await inviteMember(owner, ws.id, aemail, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const args = {
    owner: "acme",
    repo: "platform",
    title: "Handle failed webhook retries",
    body: SECRET_BODY,
    labels: ["bug"],
  };
  const propose = (over: Record<string, unknown> = {}) =>
    createProposal({ principal, capability: "github.propose_issue", args: { ...args, ...over } });
  const decide = (id: string, decision: "approve" | "deny" | "cancel", expectedVersion = 1) =>
    decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: id,
      decision,
      expectedVersion,
      reason: decision === "deny" ? "Duplicate of an existing issue" : undefined,
    });
  const receiptsOf = (id: string) => getReceiptsForProposal(owner, ws.id, id);
  return { fake, owner, approver, ws, args, propose, decide, receiptsOf };
}

describe("receipt for a completed GitHub issue", () => {
  it("records who, what, where, the provider result and verified hashes, without credentials or the body", async () => {
    const s = await setup();
    const p = await s.propose();
    await s.decide(p.proposalId, "approve");
    await executeApprovedProposal(p.proposalId);

    const rs = await s.receiptsOf(p.proposalId);
    expect(rs).toHaveLength(1);
    const r = rs[0]!.body;
    expect(rs[0]!.kind).toBe("original");
    expect(r.receiptNumber).toBe(receiptNumber(rs[0]!.id));
    expect(r).toMatchObject({
      schema: 1,
      finalState: "SUCCEEDED",
      client: { label: "Claude" },
      workspace: { name: "Receipts HQ" },
      initiatedBy: { name: "Maya Chen" },
      decision: { outcome: "approved", by: { name: "Dev Patel" } },
      connector: {
        provider: "github",
        displayName: "Acme Engineering GitHub",
        externalAccountId: "583231",
      },
      action: { destination: "acme/platform", summary: "Create GitHub issue in acme/platform" },
      execution: {
        state: "SUCCEEDED",
        attempts: 1,
        result: { providerId: "1", url: "https://github.com/acme/platform/issues/1" },
        error: null,
      },
    });
    expect(r.decision.at).toBeTruthy();
    expect(r.execution!.finishedAt).toBeTruthy();
    expect(r.proposal.correlationId).toBeTruthy();
    expect(r.action.facts).toEqual(
      expect.arrayContaining([
        { label: "Repository", value: "acme/platform" },
        { label: "Title", value: "Handle failed webhook retries" },
        { label: "Labels", value: "bug" },
      ]),
    );

    // Hashes bind to the exact normalized content that was approved.
    const args = {
      owner: "acme",
      repo: "platform",
      title: "Handle failed webhook retries",
      body: SECRET_BODY,
      labels: ["bug"],
    };
    expect(r.hashes.approvedContent).toBe(argsHash(args));
    expect(r.hashes.originalProposal).toBe(r.hashes.approvedContent);
    expect(r.hashes.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(r.humanEdits).toMatchObject({ count: 0, diff: [] });

    const json = JSON.stringify(rs);
    expect(json).not.toContain(SECRET_BODY);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toMatch(/access_token|refresh_token|client_secret|authorization/i);
  });

  it("identifies who edited, shows the diff, and keeps the AI's original hash distinct", async () => {
    const s = await setup();
    const p = await s.propose();
    await editProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: p.proposalId,
      expectedVersion: 1,
      args: { ...s.args, title: "Handle webhook retry failures", labels: ["bug", "api"] },
      reason: "Clearer title",
    });
    await s.decide(p.proposalId, "approve", 2);
    await executeApprovedProposal(p.proposalId);

    const r = (await s.receiptsOf(p.proposalId))[0]!.body;
    expect(r.proposal.version).toBe(2);
    expect(r.hashes.originalProposal).not.toBe(r.hashes.approvedContent);
    expect(r.humanEdits.count).toBe(1);
    expect(r.humanEdits.versions).toEqual([
      expect.objectContaining({
        version: 2,
        by: expect.objectContaining({ name: "Dev Patel" }),
        reason: "Clearer title",
      }),
    ]);
    expect(r.humanEdits.diff.map((d) => d.key).sort()).toEqual(["labels", "title"]);
    const title = r.humanEdits.diff.find((d) => d.key === "title");
    expect(title).toMatchObject({
      kind: "scalar",
      before: "Handle failed webhook retries",
      after: "Handle webhook retry failures",
    });
    expect(r.action.facts.find((f) => f.label === "Title")!.value).toBe(
      "Handle webhook retry failures",
    );
  });
});

describe("receipts for every settled outcome", () => {
  it("issues one for denial (with the reason), cancellation and expiry", async () => {
    const s = await setup();
    const denied = await s.propose();
    await s.decide(denied.proposalId, "deny");
    const dr = (await s.receiptsOf(denied.proposalId))[0]!.body;
    expect(dr).toMatchObject({
      finalState: "DENIED",
      decision: {
        outcome: "denied",
        reason: "Duplicate of an existing issue",
        by: { name: "Dev Patel" },
      },
      execution: null,
    });

    const canceled = await s.propose();
    await s.decide(canceled.proposalId, "cancel");
    expect((await s.receiptsOf(canceled.proposalId))[0]!.body).toMatchObject({
      finalState: "CANCELED",
      decision: { outcome: "canceled" },
    });

    const expired = await s.propose();
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, expired.proposalId));
    await sweepExpired();
    expect((await s.receiptsOf(expired.proposalId))[0]!.body).toMatchObject({
      finalState: "EXPIRED",
      decision: { outcome: "expired", by: null },
    });
  });

  it("explains a confirmed failure with a category and recovery guidance", async () => {
    const s = await setup({ failures: { "/repos/acme/platform/issues": 404 } });
    const p = await s.propose();
    await s.decide(p.proposalId, "approve");
    await executeApprovedProposal(p.proposalId);
    const r = (await s.receiptsOf(p.proposalId))[0]!.body;
    expect(r.finalState).toBe("FAILED");
    expect(r.execution!.error).toMatchObject({
      category: "destination_inaccessible",
      title: expect.stringMatching(/no longer accessible/i),
    });
    expect(r.execution!.error!.recovery.length).toBeGreaterThan(10);
    expect(r.execution!.result).toBeNull();
  });

  it("never marks pending or executing proposals as settled", async () => {
    const s = await setup();
    const p = await s.propose();
    expect(await s.receiptsOf(p.proposalId)).toHaveLength(0);
    await s.decide(p.proposalId, "approve");
    expect(await s.receiptsOf(p.proposalId)).toHaveLength(0);
  });
});

describe("unknown outcomes and corrections", () => {
  it("issues an 'unknown' receipt, then appends a linked correction when reconciliation confirms it", async () => {
    const s = await setup({ dropIssueResponse: true });
    const p = await s.propose();
    await s.decide(p.proposalId, "approve");
    await executeApprovedProposal(p.proposalId);

    let rs = await s.receiptsOf(p.proposalId);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.body).toMatchObject({
      kind: "original",
      finalState: "OUTCOME_UNKNOWN",
      execution: {
        state: "OUTCOME_UNKNOWN",
        result: null,
        error: { category: "verification_required" },
      },
    });
    const originalSnapshot = JSON.stringify(rs[0]!.body);

    const orig = s.fake.fetchImpl;
    const listing: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/acme/platform/issues" && (init?.method ?? "GET") === "GET")
        return Response.json(
          s.fake.issues.map((i) => ({
            id: 900000 + i.number,
            number: i.number,
            html_url: `https://github.com/acme/platform/issues/${i.number}`,
            body: i.body,
          })),
        );
      return orig(input, init);
    };
    setTransportOverride(
      "github",
      createSafeFetch({
        allowedOrigins: ["https://api.github.com"],
        fetchImpl: listing,
        sleep: async () => {},
      }),
    );
    await reconcileUnknownOutcomes();

    rs = await s.receiptsOf(p.proposalId);
    expect(rs.map((r) => [r.kind, r.body.finalState])).toEqual([
      ["original", "OUTCOME_UNKNOWN"],
      ["correction", "SUCCEEDED"],
    ]);
    expect(rs[1]!.body.correctsReceiptNumber).toBe(receiptNumber(rs[0]!.id));
    expect(rs[1]!.body.execution!.result!.url).toBe("https://github.com/acme/platform/issues/1");
    // The original is untouched, byte for byte.
    expect(JSON.stringify(rs[0]!.body)).toBe(originalSnapshot);
    const [row] = await getDb().select().from(receipts).where(eq(receipts.id, rs[1]!.id));
    expect(row!.correctsReceiptId).toBe(rs[0]!.id);
  });

  it("cannot be rewritten or deleted through the normal interface", async () => {
    const s = await setup();
    const p = await s.propose();
    await s.decide(p.proposalId, "deny");
    const [r] = await s.receiptsOf(p.proposalId);
    await expect(
      getDb().update(receipts).set({ body: {} }).where(eq(receipts.id, r!.id)),
    ).rejects.toThrow();
    await expect(getDb().delete(receipts).where(eq(receipts.id, r!.id))).rejects.toThrow();
  });
});

describe("receipt integrity and access", () => {
  it("has exactly one original per proposal even when settled repeatedly", async () => {
    const s = await setup();
    const p = await s.propose();
    await Promise.allSettled([
      s.decide(p.proposalId, "deny"),
      s.decide(p.proposalId, "deny"),
      s.decide(p.proposalId, "deny"),
    ]);
    expect(
      (await getDb().select().from(receipts).where(eq(receipts.proposalId, p.proposalId))).filter(
        (r) => r.kind === "original",
      ),
    ).toHaveLength(1);
  });

  it("backfills a settled proposal that has no receipt", async () => {
    const s = await setup();
    const p = await s.propose();
    await s.decide(p.proposalId, "deny");
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local app.retention_purge = 'on'`);
      await tx.delete(receipts).where(eq(receipts.proposalId, p.proposalId));
    });
    expect(await s.receiptsOf(p.proposalId)).toHaveLength(0);
    expect(await backfillMissingReceipts()).toBeGreaterThanOrEqual(1);
    expect((await s.receiptsOf(p.proposalId))[0]!.body.finalState).toBe("DENIED");
  });

  it("lets viewers read receipts but hides other workspaces' and malformed IDs", async () => {
    const s = await setup();
    const p = await s.propose();
    await s.decide(p.proposalId, "deny");
    const vemail = `vw${Math.random()}@example.test`;
    const viewer = await user(vemail);
    const { url } = await inviteMember(s.owner, s.ws.id, vemail, "viewer");
    await acceptInvitation(viewer, url.split("/invite/")[1]!);
    const [r] = await getReceiptsForProposal(viewer, s.ws.id, p.proposalId);
    expect((await getReceipt(viewer, s.ws.id, r!.id)).body.receiptNumber).toBe(
      r!.body.receiptNumber,
    );

    const other = await setup();
    await expect(getReceipt(other.owner, other.ws.id, r!.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getReceipt(other.owner, s.ws.id, r!.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getReceipt(s.owner, s.ws.id, "not-an-id")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
