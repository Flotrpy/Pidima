import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { executions, mcpClients, mcpGrants, proposals, users } from "@/db/schema";
import { buildMime, encodeHeaderText } from "@/connectors/gmail/mime";
import { setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { revokeConnector } from "@/server/credentials";
import { decideProposal } from "@/server/decisions";
import {
  executeApprovedProposal,
  reconcileUnknownOutcomes,
  runExecutionMaintenance,
} from "@/server/executor";
import { setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGmail, type FakeGmailOptions } from "./fake-gmail";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup(g: FakeGmailOptions = {}) {
  const fake = fakeGmail(g);
  setTransportOverride("gmail", fake.sf);
  const email = `gx${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Mail Exec");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "gmail",
    externalAccountId: "1234567890",
    displayName: "maya@acme.com",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    metadata: { email: "maya@acme.com", senderAddresses: ["maya@acme.com"] },
    credentials: { accessToken: fake.access, refreshToken: "r-1" },
  });
  await updateCapabilityPolicy(owner, ws.id, "email.propose_message", { enabled: true });
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
  const ready = async (extra: Record<string, unknown> = {}) => {
    const p = await createProposal({
      principal,
      capability: "email.propose_message",
      args: {
        from: "maya@acme.com",
        to: ["dev@acme.com"],
        subject: "Launch notes",
        textBody: "Hello team",
        ...extra,
      },
    });
    await decideProposal({
      actorId: approver,
      workspaceId: ws.id,
      proposalId: p.proposalId,
      decision: "approve",
      expectedVersion: 1,
    });
    return p.proposalId;
  };
  const stateOf = async (id: string) =>
    (await getDb().select().from(proposals).where(eq(proposals.id, id)))[0]!.state;
  const exec = async (id: string) =>
    (await getDb().select().from(executions).where(eq(executions.proposalId, id)))[0]!;
  return { fake, owner, ws, c, ready, stateOf, exec };
}

describe("approved email execution", () => {
  it("submits exactly the approved message once and records the provider message reference (acceptance, not delivery)", async () => {
    const s = await setup();
    const id = await s.ready({ cc: ["c@other.com"], bcc: ["b@other.com"] });
    expect(s.fake.sent).toHaveLength(0);
    expect(await executeApprovedProposal(id)).toMatchObject({
      status: "done",
      outcome: "succeeded",
    });
    expect(s.fake.sent).toHaveLength(1);
    const mime = s.fake.sent[0]!.mime;
    expect(mime).toMatch(
      /^From: maya@acme.com\r\nTo: dev@acme.com\r\nCc: c@other.com\r\nBcc: b@other.com\r\nSubject: Launch notes\r\n/,
    );
    expect(Buffer.from(mime.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString()).toBe(
      "Hello team",
    );
    expect(mime).toMatch(/Message-ID: <aai-[0-9a-f]{40}@acme.com>/);
    expect(await s.stateOf(id)).toBe("SUCCEEDED");
    expect((await s.exec(id)).providerResult).toMatchObject({
      providerId: s.fake.sent[0]!.id,
      messageId: s.fake.sent[0]!.id,
      recipientCount: 3,
      acceptedByProvider: true,
    });
    const auth = s.fake.calls.find((c) => c.path.endsWith("/messages/send"))!.auth;
    expect(auth).toBe(`Bearer ${s.fake.access}`);
  });

  it("builds multipart/alternative when both bodies exist, and encodes non-ASCII subjects", async () => {
    const s = await setup();
    await executeApprovedProposal(
      await s.ready({ subject: "Café ☕ update", htmlBody: "<p>Hi</p>" }),
    );
    const m = s.fake.sent[0]!.mime;
    expect(m).toMatch(/Content-Type: multipart\/alternative; boundary=/);
    expect(m).toContain("Content-Type: text/plain");
    expect(m).toContain("Content-Type: text/html");
    const subj = /Subject: (.*)\r\n/.exec(m)![1]!;
    expect(subj).toMatch(/^=\?UTF-8\?B\?/);
    expect(subj).not.toMatch(/[^\x20-\x7e]/);
  });

  it("sends only once under concurrent executors and ignores duplicate triggers", async () => {
    const s = await setup();
    const id = await s.ready();
    const r = await Promise.all(Array.from({ length: 8 }, () => executeApprovedProposal(id)));
    expect(r.filter((x) => x.status === "done")).toHaveLength(1);
    await runExecutionMaintenance();
    expect(s.fake.sent).toHaveLength(1);
  });

  it("re-validates right before sending: policy, revoked connector, sender, expiry", async () => {
    const a = await setup();
    const ida = await a.ready();
    await setResourceRule(a.owner, a.ws.id, {
      kind: "email_domain",
      value: "acme.com",
      effect: "block",
    });
    await executeApprovedProposal(ida);
    expect((await a.exec(ida)).errorCategory).toBe("policy_changed");
    const b = await setup();
    const idb = await b.ready();
    await revokeConnector(b.c.id);
    await executeApprovedProposal(idb);
    expect((await b.exec(idb)).errorCategory).toBe("auth_expired");
    const c = await setup();
    const idc = await c.ready();
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, idc));
    expect(await executeApprovedProposal(idc)).toEqual({ status: "skipped", reason: "expired" });
    for (const s of [a, b, c]) expect(s.fake.sent).toHaveLength(0);
  });
});

describe("email outcomes", () => {
  it.each([
    ["an expired token", { statuses: { "/messages/send": 401 } }, "FAILED", "auth_expired"],
    ["rate limiting", { statuses: { "/messages/send": 429 } }, "FAILED", "rate_limited"],
  ] as const)("records %s as a confirmed failure", async (_n, o, state, cat) => {
    const s = await setup(o);
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe(state);
    expect((await s.exec(id)).errorCategory).toBe(cat);
    expect(s.fake.calls.filter((c) => c.path.endsWith("/messages/send"))).toHaveLength(1);
  });

  it("treats a 5xx on send as UNKNOWN, never retries, and cannot reconcile without read scopes", async () => {
    const s = await setup({ statuses: { "/messages/send": 503 } });
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
    await runExecutionMaintenance();
    expect((await reconcileUnknownOutcomes()).resolved).toBe(0);
    expect(s.fake.calls.filter((c) => c.path.endsWith("/messages/send"))).toHaveLength(1);
  });

  it("treats a lost response after Gmail accepted the message as UNKNOWN", async () => {
    const s = await setup({ dropSendResponse: true });
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(s.fake.sent).toHaveLength(1);
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
  });
});

describe("MIME safety", () => {
  const base = {
    from: "a@b.co",
    to: ["c@d.co"],
    cc: [],
    bcc: [],
    subject: "s",
    textBody: "x",
    messageId: "id@b.co",
  };
  it("refuses any CR/LF/NUL in header-bound fields", () => {
    for (const bad of [
      { subject: "a\r\nBcc: x@y.co" },
      { from: "a@b.co\nBcc: x" },
      { to: ["c@d.co\r\nBcc: e@f.co"] },
      { messageId: "x\r\ny" },
    ]) {
      expect(() => buildMime({ ...base, ...bad })).toThrow();
    }
  });
  it("encodes long non-ASCII header text into bounded words", () => {
    const enc = encodeHeaderText("日本語".repeat(20));
    expect(enc.split(" ").every((w) => w.length <= 75)).toBe(true);
  });
  it("keeps body lines short and CRLF-terminated", () => {
    const m = buildMime({ ...base, textBody: "line\n".repeat(500) });
    expect(m.split("\r\n").every((l) => l.length <= 998)).toBe(true);
    expect(m).not.toMatch(/(?<!\r)\n/);
  });
});
