import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, notifications, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { reportAuthFailure } from "@/server/credentials";
import { decideProposal } from "@/server/decisions";
import { executeApprovedProposal } from "@/server/executor";
import { outbox } from "@/server/mailer";
import {
  emailCopy,
  listNotifications,
  markAllRead,
  startNotifications,
  unreadCount,
} from "@/server/notifications";
import { updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGithub, type FakeGithubOptions } from "./fake-github";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);
const SECRET = "CONFIDENTIAL-TITLE-XYZ";

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}
async function setup(gh: FakeGithubOptions = {}) {
  setTransportOverride("github", fakeGithub(gh).sf);
  const oe = `no${Math.random()}@example.test`,
    ae = `na${Math.random()}@example.test`,
    me = `nm${Math.random()}@example.test`;
  const owner = await user(oe);
  const ws = await createWorkspace(owner, "Notify HQ");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "github",
    externalAccountId: "583231",
    displayName: "octocat",
    grantedScopes: ["repo"],
    credentials: { accessToken: "gho_test_token_123" },
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
  const approver = await user(ae);
  const member = await user(me);
  for (const [id, email, role] of [
    [approver, ae, "approver"],
    [member, me, "member"],
  ] as const) {
    const { url } = await inviteMember(owner, ws.id, email, role);
    await acceptInvitation(id, url.split("/invite/")[1]!);
  }
  const principal: Principal = {
    grantId: grant!.id,
    userId: owner,
    workspaceId: ws.id,
    clientLabel: "Claude",
  };
  const propose = (title = SECRET) =>
    createProposal({
      principal,
      capability: "github.propose_issue",
      args: { owner: "acme", repo: "platform", title, body: "b" },
    });
  return { owner, approver, member, ae, me, oe, ws, c, propose };
}
const mailsTo = (email: string) => outbox.filter((m) => m.to === email);

describe("review-request notifications", () => {
  it("notify only people who can decide, with a content-free secure link, and never the requester by default", async () => {
    const s = await setup();
    const stop = startNotifications();
    try {
      const p = await s.propose();
      expect(await listNotifications(s.approver)).toMatchObject([
        { kind: "review_requested", proposalId: p.proposalId },
      ]);
      expect(await listNotifications(s.member)).toHaveLength(0);
      expect(await listNotifications(s.owner)).toHaveLength(0); // requester, self-approval off
      const mail = mailsTo(s.ae).at(-1)!;
      expect(mail.text).toContain(`http://localhost:3000/inbox/${p.proposalId}`);
      expect(mail.subject + mail.text).not.toContain(SECRET);
      expect(mail.subject + mail.text).not.toMatch(/acme\/platform|octocat/);
      expect(mail.text).toMatch(/does not approve anything/);
    } finally {
      stop();
    }
  });

  it("includes the requester when the workspace allows self-approval", async () => {
    const s = await setup();
    await updateCapabilityPolicy(s.owner, s.ws.id, "github.propose_issue", {
      allowSelfApproval: true,
    });
    const stop = startNotifications();
    try {
      await s.propose();
      expect(await listNotifications(s.owner)).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("deduplicates per proposal and groups emails within the cooldown", async () => {
    const s = await setup();
    const stop = startNotifications();
    try {
      const a = await s.propose("a");
      await s.propose("b");
      await s.propose("c");
      expect(await listNotifications(s.approver)).toHaveLength(3); // in-app keeps every distinct request
      expect(
        mailsTo(s.ae).filter((m) => m.subject.includes("waiting for your review")),
      ).toHaveLength(1); // one email, not three
      const { notifyReviewRequested } = await import("@/server/notifications");
      await notifyReviewRequested(a.proposalId);
      expect(await listNotifications(s.approver)).toHaveLength(3); // same proposal again is a no-op
    } finally {
      stop();
    }
  });

  it("tracks unread counts and marks everything read", async () => {
    const s = await setup();
    const stop = startNotifications();
    try {
      await s.propose("a");
      await s.propose("b");
      expect(await unreadCount(s.approver)).toBe(2);
      await markAllRead(s.approver);
      expect(await unreadCount(s.approver)).toBe(0);
      expect(await unreadCount(s.owner)).toBe(0);
    } finally {
      stop();
    }
  });

  it("does not let an email failure break proposing or lose the in-app notification", async () => {
    const s = await setup();
    const stop = startNotifications();
    const { sendMail } = await import("@/server/mailer");
    void sendMail;
    try {
      await getDb().update(users).set({ emailVerified: false }).where(eq(users.id, s.approver));
      await s.propose();
      expect(await listNotifications(s.approver)).toHaveLength(1);
      expect((await listNotifications(s.approver))[0]!.emailedAt).toBeNull();
    } finally {
      stop();
    }
  });
});

describe("outcome notifications", () => {
  async function approved(s: Awaited<ReturnType<typeof setup>>) {
    const p = await s.propose();
    await decideProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: p.proposalId,
      decision: "approve",
      expectedVersion: 1,
    });
    return p.proposalId;
  }
  it("tells the approver and requester when an approved action fails, without content", async () => {
    const s = await setup({ failures: { "/repos/acme/platform/issues": 404 } });
    const id = await approved(s);
    await executeApprovedProposal(id);
    for (const uid of [s.approver, s.owner])
      expect((await listNotifications(uid)).map((n) => n.kind)).toContain("execution_failed");
    const mail = mailsTo(s.ae).find((m) => m.subject.includes("did not complete"))!;
    expect(mail.text).toContain(`/inbox/${id}`);
    expect(mail.text).not.toContain(SECRET);
  });

  it("flags an unknown outcome distinctly and sends nothing for successes", async () => {
    const s = await setup({ failures: { "/repos/acme/platform/issues": 503 } });
    await executeApprovedProposal(await approved(s));
    expect((await listNotifications(s.approver)).map((n) => n.kind)).toContain("outcome_unknown");
    const ok = await setup();
    await executeApprovedProposal(await approved(ok));
    expect(
      (await listNotifications(ok.approver)).filter((n) => n.kind !== "review_requested"),
    ).toHaveLength(0);
  });

  it("alerts owners when a connector needs reauthorization, once", async () => {
    const s = await setup();
    await reportAuthFailure(s.c.id);
    await reportAuthFailure(s.c.id);
    const n = (await listNotifications(s.owner)).filter((x) => x.kind === "connector_unhealthy");
    expect(n).toHaveLength(1);
    expect(mailsTo(s.oe).at(-1)!.text).toContain("/connections");
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });
});

describe("email copy", () => {
  it("is content-free for every kind and always links to an authenticated page", () => {
    for (const k of [
      "review_requested",
      "execution_failed",
      "outcome_unknown",
      "connector_unhealthy",
    ] as const) {
      const c = emailCopy(k, "Acme HQ", "/inbox/abc", 1);
      expect(c.text).toContain("http://localhost:3000/inbox/abc");
      expect(c.text).toMatch(/sign-in required/);
    }
    expect(emailCopy("review_requested", "W", "/x", 3).text).toMatch(/3 AI requests are waiting/);
    void notifications;
  });
});
