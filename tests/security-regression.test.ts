import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { githubIssueArgs } from "@/connectors/capabilities/github-issue";
import { connectAccount, disconnectConnector, testConnector } from "@/server/connectors";
import { decideProposal } from "@/server/decisions";
import { editProposal } from "@/server/edits";
import { executeApprovedProposal } from "@/server/executor";
import { getProposalDetail, listProposals } from "@/server/inbox";
import { listActivity } from "@/server/activity";
import { revokeGrant } from "@/server/mcp-consent";
import { outbox } from "@/server/mailer";
import {
  listNotifications,
  notifyExecutionOutcome,
  notifyReviewRequested,
} from "@/server/notifications";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { exportReceipt, getReceiptsForProposal, listHistory } from "@/server/receipts";
import { isSameSiteNavigation } from "@/server/route-guards";
import { listVersions } from "@/server/versions";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGithub } from "./fake-github";
import { resetTestDatabase } from "./helpers";
import { GET as githubStart } from "@/app/api/connectors/github/start/route";
import { GET as slackStart } from "@/app/api/connectors/slack/start/route";
import { GET as gmailStart } from "@/app/api/connectors/gmail/start/route";

beforeAll(resetTestDatabase);

const TOKEN = "gho_CANARY_TOKEN_0001";
const BODY = "CANARY-BODY-TEXT-7781";

async function world() {
  const fake = fakeGithub({ token: TOKEN });
  setTransportOverride("github", fake.sf);
  const oe = `sec${Math.random()}@example.test`;
  await signInAs(oe);
  const owner = (await getDb().select().from(users).where(eq(users.email, oe)))[0]!.id;
  const ws = await createWorkspace(owner, "Sec");
  const conn = await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: TOKEN, refreshToken: "gho_CANARY_REFRESH" },
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
      scopes: ["proposals:create", "proposals:read"],
    })
    .returning();
  const ae = `secap${Math.random()}@example.test`;
  await signInAs(ae);
  const approver = (await getDb().select().from(users).where(eq(users.email, ae)))[0]!.id;
  const { url } = await inviteMember(owner, ws.id, ae, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const propose = (over: Record<string, unknown> = {}) =>
    createProposal({
      principal,
      capability: "github.propose_issue",
      args: { owner: "acme", repo: "platform", title: "T", body: BODY, ...over },
    });
  const approve = (id: string, v = 1) =>
    decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: id,
      decision: "approve",
      expectedVersion: v,
    });
  return { fake, owner, approver, ws, conn, grant: grant!, propose, approve };
}

describe("cross-workspace isolation: every read and write path answers 'not found'", () => {
  it("covers proposals, decisions, edits, receipts, exports, history, activity, connectors and grants", async () => {
    const a = await world();
    const b = await world();
    const p = await a.propose();
    await a.approve(p.proposalId);
    await executeApprovedProposal(p.proposalId);
    const [rec] = await getReceiptsForProposal(a.owner, a.ws.id, p.proposalId);
    const nf = { code: "not_found" };
    // B's users addressing A's workspace, and B's workspace addressing A's objects.
    await expect(getProposalDetail(b.owner, a.ws.id, p.proposalId)).rejects.toMatchObject(nf);
    await expect(getProposalDetail(b.owner, b.ws.id, p.proposalId)).rejects.toMatchObject(nf);
    await expect(listProposals(b.owner, a.ws.id, "completed")).rejects.toMatchObject(nf);
    await expect(
      decideProposal({
        actorId: b.approver,
        workspaceId: b.ws.id,
        proposalId: p.proposalId,
        decision: "deny",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject(nf);
    await expect(
      editProposal({
        actorId: b.approver,
        workspaceId: b.ws.id,
        proposalId: p.proposalId,
        expectedVersion: 1,
        args: { owner: "x", repo: "y", title: "t" },
      }),
    ).rejects.toMatchObject(nf);
    await expect(exportReceipt(b.owner, b.ws.id, rec!.id)).rejects.toMatchObject(nf);
    await expect(getReceiptsForProposal(b.owner, a.ws.id, p.proposalId)).rejects.toMatchObject(nf);
    await expect(listHistory(b.owner, a.ws.id)).rejects.toMatchObject(nf);
    await expect(listActivity(b.owner, a.ws.id)).rejects.toMatchObject(nf);
    await expect(testConnector(b.owner, a.conn.id)).rejects.toMatchObject(nf);
    await expect(disconnectConnector(b.owner, a.conn.id)).rejects.toMatchObject(nf);
    await expect(revokeGrant(b.owner, a.grant.id)).rejects.toMatchObject(nf);
    // B's own history never contains A's receipts.
    expect((await listHistory(b.owner, b.ws.id)).items).toHaveLength(0);
    // A is untouched.
    const [row] = await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId));
    expect(row!.state).toBe("SUCCEEDED");
  });

  it("refuses to attach another workspace's connector to a proposal", async () => {
    const a = await world();
    const b = await world();
    const principal: Principal = {
      grantId: a.grant.id,
      userId: a.owner,
      workspaceId: a.ws.id,
      clientLabel: "Claude",
    };
    const err = await createProposal({
      principal,
      capability: "github.propose_issue",
      args: { owner: "acme", repo: "platform", title: "t" },
      connectorAccountId: b.conn.id,
    }).then(
      (r) => ({ created: r }),
      (e) => e,
    );
    expect(err.created).toBeUndefined();
    expect(err.code).toBe("connector_required");
  });
});

describe("forged review links and GET safety", () => {
  it("a review link identifies a proposal but never acts: loading it changes nothing", async () => {
    const w = await world();
    const p = await w.propose();
    const before = (
      await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId))
    )[0]!;
    for (let i = 0; i < 3; i++) await getProposalDetail(w.approver, w.ws.id, p.proposalId);
    const after = (
      await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId))
    )[0]!;
    expect(after.state).toBe("PENDING_APPROVAL");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(w.fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("guessed, malformed and traversal-shaped IDs are indistinguishable from missing ones", async () => {
    const w = await world();
    for (const id of [
      "00000000-0000-0000-0000-000000000000",
      "../../etc/passwd",
      "'; drop table proposals;--",
      "%00",
      "a".repeat(5000),
    ]) {
      await expect(getProposalDetail(w.approver, w.ws.id, id)).rejects.toMatchObject({
        code: "not_found",
      });
    }
  });

  it("OAuth start endpoints refuse cross-site navigations before doing anything", async () => {
    const xs = (p: string) =>
      new Request(`http://localhost:3000${p}`, { headers: { "sec-fetch-site": "cross-site" } });
    for (const h of [githubStart, slackStart, gmailStart]) {
      const res = await h(xs("/api/connectors/x/start"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("connect_error=invalid");
    }
    expect(
      isSameSiteNavigation(new Request("http://x", { headers: { "sec-fetch-site": "same-site" } })),
    ).toBe(false);
  });
});

describe("replay and substitution", () => {
  it("a repeated or stale approval cannot run anything twice or approve different content", async () => {
    const w = await world();
    const p = await w.propose();
    await w.approve(p.proposalId);
    await w.approve(p.proposalId);
    await executeApprovedProposal(p.proposalId);
    await executeApprovedProposal(p.proposalId);
    await w.approve(p.proposalId);
    expect(w.fake.issues).toHaveLength(1);
  });

  it("content cannot be swapped after approval: direct updates are blocked and tampering is detected", async () => {
    const w = await world();
    const p = await w.propose();
    await w.approve(p.proposalId);
    const [v] = await listVersions(p.proposalId);
    const { proposalVersions } = await import("@/db/schema");
    await expect(
      getDb()
        .update(proposalVersions)
        .set({ destination: "evil/repo" })
        .where(eq(proposalVersions.id, v!.id)),
    ).rejects.toThrow();
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`alter table proposal_versions disable trigger proposal_versions_immutable`,
      );
      await tx.execute(
        sql`update proposal_versions set args = jsonb_set(args, '{repo}', '"secrets"'), destination = 'acme/secrets' where id = ${v!.id}`,
      );
      await tx.execute(
        sql`alter table proposal_versions enable trigger proposal_versions_immutable`,
      );
    });
    await executeApprovedProposal(p.proposalId);
    expect(w.fake.issues).toHaveLength(0);
    expect(
      (await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId)))[0]!.state,
    ).toBe("FAILED");
  });

  it("an edit racing an approval yields exactly one consistent outcome", async () => {
    const w = await world();
    const p = await w.propose();
    const results = await Promise.allSettled([
      w.approve(p.proposalId, 1),
      editProposal({
        actorId: w.approver,
        workspaceId: w.ws.id,
        proposalId: p.proposalId,
        expectedVersion: 1,
        args: { owner: "acme", repo: "platform", title: "EDITED", body: BODY },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await executeApprovedProposal(p.proposalId);
    const created = w.fake.issues[0];
    // Whatever ran is exactly the version that was approved: never a mix.
    if (created) expect(created.title).toBe("T");
    else
      expect(
        (await getDb().select().from(proposals).where(eq(proposals.id, p.proposalId)))[0]!
          .currentVersion,
      ).toBe(2);
  });

  it("prototype-pollution shaped arguments are stripped, never merged", () => {
    const parsed = githubIssueArgs.parse(
      JSON.parse(
        '{"owner":"a","repo":"b","title":"t","__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
      ),
    );
    expect(Object.keys(parsed).sort()).toEqual(["body", "labels", "owner", "repo", "title"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("stored content injection", () => {
  it("renders hostile proposal content as inert text on the review screen", async () => {
    const w = await world();
    const hostile = `<img src=x onerror=alert(1)><script>alert(2)</script>‮{{7*7}}`;
    const p = await w.propose({ title: "<b>bold</b>", body: hostile });
    const d = await getProposalDetail(w.approver, w.ws.id, p.proposalId);
    const { ReviewPanel } = await import("@/components/inbox/ReviewPanel");
    const html = renderToStaticMarkup(ReviewPanel({ d }) as never);
    // Only real tags are a problem; the escaped text "onerror=alert(1)" is inert.
    expect(html).not.toMatch(/<script|<img[\s>]/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(d.hiddenDirectionWarning).toBe(true);
  });
});

describe("sensitive data never leaks outside its vault", () => {
  it("keeps credentials and message bodies out of audit, notifications, receipts, exports, MCP-facing summaries and email", async () => {
    const w = await world();
    const p = await w.propose();
    await notifyReviewRequested(p.proposalId);
    await w.approve(p.proposalId);
    await executeApprovedProposal(p.proposalId);
    await notifyExecutionOutcome(p.proposalId, "failed");
    const db = getDb();
    const dump = async (t: string) =>
      JSON.stringify((await db.execute(sql.raw(`select * from ${t} where true`))).rows);
    const all = (
      await Promise.all(
        [
          "audit_events",
          "notifications",
          "receipts",
          "executions",
          "execution_attempts",
          "approval_decisions",
          "connector_tests",
          "connector_accounts",
          "proposals",
          "oauth_transactions",
        ].map(dump),
      )
    ).join("\n");
    for (const canary of [TOKEN, "gho_CANARY_REFRESH"]) expect(all).not.toContain(canary);
    // The body is only legitimately stored in the immutable version row.
    for (const t of ["audit_events", "notifications", "receipts", "executions"])
      expect(await dump(t)).not.toContain(BODY);
    const [rec] = await getReceiptsForProposal(w.owner, w.ws.id, p.proposalId);
    const { json } = await exportReceipt(w.owner, w.ws.id, rec!.id);
    expect(
      json + JSON.stringify(await listNotifications(w.approver)) + JSON.stringify(outbox),
    ).not.toContain(BODY);
    expect(json).not.toContain(TOKEN);
    const enc = await db.execute(sql`select ciphertext from encrypted_credentials`);
    expect(JSON.stringify(enc.rows)).not.toContain(Buffer.from(TOKEN).toString("base64"));
  });
});
