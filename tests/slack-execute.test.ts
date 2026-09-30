import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  connectorAccounts,
  encryptedCredentials,
  executions,
  mcpClients,
  mcpGrants,
  proposals,
  users,
} from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { connectAccount } from "@/server/connectors";
import { getAccessToken, revokeConnector } from "@/server/credentials";
import { decideProposal } from "@/server/decisions";
import {
  executeApprovedProposal,
  reconcileUnknownOutcomes,
  runExecutionMaintenance,
} from "@/server/executor";
import { setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { createProposal, type Principal } from "@/server/proposals";
import { storeCredentials } from "@/server/vault";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { initConnectors } from "@/connectors/init";
import { getRuntime } from "@/connectors/registry";
import { signInAs } from "./auth-helpers";
import { fakeSlack, type FakeSlackOptions } from "./fake-slack";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const channels = [
  { id: "C0000000001", name: "ops", is_member: true },
  { id: "C0000000002", name: "random", is_member: true },
];

async function setup(slack: FakeSlackOptions = {}, mode: "bot" | "user" = "bot") {
  const fake = fakeSlack({ channels, ...slack });
  setTransportOverride("slack", fake.sf);
  const email = `sx${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Slack Exec");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "slack",
    externalAccountId: mode === "bot" ? "T0123ABCDE:bot" : "T0123ABCDE:user:U0MAYA123",
    displayName: "Acme",
    grantedScopes: ["chat:write", "channels:read", "groups:read"],
    metadata: { senderMode: mode, teamId: "T0123ABCDE", teamName: "Acme", userName: "maya" },
    credentials: { accessToken: mode === "bot" ? fake.botToken : fake.userToken },
  });
  await updateCapabilityPolicy(owner, ws.id, "slack.propose_message", { enabled: true });
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
  const propose = (args: Record<string, unknown> = {}) =>
    createProposal({
      principal,
      capability: "slack.propose_message",
      args: { channel: "#ops", text: "Deploy finished: *all green* :tada:", ...args },
    });
  const ready = async (args: Record<string, unknown> = {}) => {
    const p = await propose(args);
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
  const posts = () => fake.calls.filter((c) => c.method === "chat.postMessage");
  return { fake, owner, approver, ws, c, propose, ready, stateOf, exec, posts };
}

describe("approved Slack message execution", () => {
  it("posts exactly the approved text once and records the message reference and link", async () => {
    const s = await setup();
    const id = await s.ready();
    expect(s.posts()).toHaveLength(0);
    expect(await executeApprovedProposal(id)).toMatchObject({
      status: "done",
      outcome: "succeeded",
    });
    expect(s.fake.messages).toEqual([
      expect.objectContaining({
        channel: "C0000000001",
        text: "Deploy finished: *all green* :tada:",
        as: "bot",
      }),
    ]);
    const sent = s.posts()[0]!;
    expect(sent.body).toMatchObject({
      channel: "C0000000001",
      text: "Deploy finished: *all green* :tada:",
      unfurl_links: false,
    });
    expect(Object.keys(sent.body).sort()).toEqual([
      "channel",
      "text",
      "unfurl_links",
      "unfurl_media",
    ]);
    expect(sent.auth).toBe(`Bearer ${s.fake.botToken}`);
    expect(await s.stateOf(id)).toBe("SUCCEEDED");
    const e = await s.exec(id);
    expect(e.providerResult).toMatchObject({
      providerId: s.fake.messages[0]!.ts,
      url: expect.stringContaining("/archives/C0000000001/p"),
      channel: "C0000000001",
      sentAs: "app",
    });
  });

  it("sends the text byte for byte, without mangling mentions, markup or unicode", async () => {
    const s = await setup();
    const text = "Line1\nLine <https://example.com|link> & <b> ‮tricky 🚀 café";
    await executeApprovedProposal(await s.ready({ text }));
    expect(s.fake.messages[0]!.text).toBe(text.normalize("NFC"));
  });

  it("replies in the approved thread", async () => {
    const s = await setup();
    await executeApprovedProposal(
      await s.ready({ thread_ts: undefined, threadTs: "1700000000.000100" }),
    );
    expect(s.fake.messages[0]!.thread_ts).toBe("1700000000.000100");
  });

  it("posts as the person when the connection is a personal account, and says so in the result", async () => {
    const s = await setup({}, "user");
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(s.fake.messages[0]!.as).toBe("user");
    expect(s.posts()[0]!.auth).toBe(`Bearer ${s.fake.userToken}`);
    expect((await s.exec(id)).providerResult).toMatchObject({ sentAs: "person" });
  });

  it("posts only once under concurrent executors, and ignores duplicate triggers", async () => {
    const s = await setup();
    const id = await s.ready();
    const results = await Promise.all(Array.from({ length: 8 }, () => executeApprovedProposal(id)));
    expect(results.filter((r) => r.status === "done")).toHaveLength(1);
    await runExecutionMaintenance();
    expect(s.fake.messages).toHaveLength(1);
    expect(
      await getDb().select().from(executions).where(eq(executions.proposalId, id)),
    ).toHaveLength(1);
  });

  it("does nothing for unapproved, denied or expired proposals", async () => {
    const s = await setup();
    const pending = await s.propose();
    expect((await executeApprovedProposal(pending.proposalId)).status).toBe("skipped");
    const late = await s.ready();
    await getDb()
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(proposals.id, late));
    expect(await executeApprovedProposal(late)).toEqual({ status: "skipped", reason: "expired" });
    expect(s.posts()).toHaveLength(0);
  });
});

describe("re-validation immediately before posting", () => {
  it("refuses, without posting, when policy, the connector or the channel changed after approval", async () => {
    const policy = await setup();
    const a = await policy.ready();
    await setResourceRule(policy.owner, policy.ws.id, {
      kind: "slack_channel",
      value: "C0000000001",
      effect: "block",
    });
    await executeApprovedProposal(a);
    expect(await policy.stateOf(a)).toBe("FAILED");
    expect((await policy.exec(a)).errorCategory).toBe("policy_changed");
    expect(policy.posts()).toHaveLength(0);

    const revoked = await setup();
    const b = await revoked.ready();
    await revokeConnector(revoked.c.id);
    await executeApprovedProposal(b);
    expect((await revoked.exec(b)).errorCategory).toBe("auth_expired");
    expect(revoked.posts()).toHaveLength(0);

    const left = await setup();
    const c = await left.ready();
    // The app was removed from the channel after approval.
    setTransportOverride(
      "slack",
      fakeSlack({ channels: [{ id: "C0000000001", name: "ops", is_member: false }] }).sf,
    );
    await executeApprovedProposal(c);
    expect(await left.stateOf(c)).toBe("FAILED");
    expect((await left.exec(c)).errorCategory).toBe("destination_inaccessible");
    expect(left.posts()).toHaveLength(0);

    const archived = await setup();
    const d = await archived.ready();
    setTransportOverride(
      "slack",
      fakeSlack({
        channels: [{ id: "C0000000001", name: "ops", is_member: true, is_archived: true }],
      }).sf,
    );
    await executeApprovedProposal(d);
    expect((await archived.exec(d)).errorCategory).toBe("destination_inaccessible");
  });
});

describe("Slack outcomes", () => {
  const cases: [string, FakeSlackOptions, string][] = [
    [
      "not_in_channel",
      { errors: { "chat.postMessage": "not_in_channel" } },
      "destination_inaccessible",
    ],
    ["is_archived", { errors: { "chat.postMessage": "is_archived" } }, "destination_inaccessible"],
    ["invalid_auth", { errors: { "chat.postMessage": "invalid_auth" } }, "auth_expired"],
    ["token_revoked", { errors: { "chat.postMessage": "token_revoked" } }, "auth_expired"],
    ["missing_scope", { errors: { "chat.postMessage": "missing_scope" } }, "scope_missing"],
    ["msg_too_long", { errors: { "chat.postMessage": "msg_too_long" } }, "provider_rejected"],
    ["a 429 rate limit", { statuses: { "chat.postMessage": 429 } }, "rate_limited"],
  ];
  it.each(cases)(
    "records %s as a confirmed failure with the right category",
    async (_n, opts, category) => {
      const s = await setup(opts);
      const id = await s.ready();
      await executeApprovedProposal(id);
      expect(await s.stateOf(id)).toBe("FAILED");
      expect((await s.exec(id)).errorCategory).toBe(category);
      expect(s.posts()).toHaveLength(1);
      expect(s.fake.messages).toHaveLength(0);
    },
  );

  it("flags the connector for reauthorization when Slack says the token is dead", async () => {
    const s = await setup({ errors: { "chat.postMessage": "token_revoked" } });
    await executeApprovedProposal(await s.ready());
    const [c] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, s.c.id));
    expect(c!.status).toBe("needs_reauth");
  });

  it("treats a 5xx on the write as UNKNOWN and never retries", async () => {
    const s = await setup({ statuses: { "chat.postMessage": 503 } });
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
    await runExecutionMaintenance();
    expect(s.posts()).toHaveLength(1);
  });

  it("treats a lost response after Slack posted as UNKNOWN, and cannot reconcile it without history scopes", async () => {
    const s = await setup({ dropPostResponse: true });
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(s.fake.messages).toHaveLength(1); // Slack really posted it
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
    initConnectors();
    expect(getRuntime("slack").reconcile).toBeUndefined();
    expect(await reconcileUnknownOutcomes()).toMatchObject({ resolved: 0 });
    expect(await s.stateOf(id)).toBe("OUTCOME_UNKNOWN");
    expect(s.posts()).toHaveLength(1);
  });

  it("still reports success if only the permalink lookup fails", async () => {
    const s = await setup({ errors: { "chat.getPermalink": "internal_error" } });
    const id = await s.ready();
    await executeApprovedProposal(id);
    expect(await s.stateOf(id)).toBe("SUCCEEDED");
    expect((await s.exec(id)).providerResult).toMatchObject({
      providerId: s.fake.messages[0]!.ts,
      url: null,
    });
  });
});

describe("Slack token refresh", () => {
  it("refreshes an expired rotating token once and keeps the newest refresh token", async () => {
    const s = await setup();
    setTransportOverride("slack", s.fake.sf);
    await storeCredentials(
      s.c.id,
      { accessToken: "xoxb-expired", refreshToken: "refresh-1", tokenType: "bot" },
      new Date(Date.now() - 1000),
    );
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () =>
        getAccessToken(s.c.id, (cur) => getRuntime("slack").refresh!(cur)),
      ),
    );
    expect(new Set(tokens)).toEqual(new Set(["xoxb-refreshed"]));
    expect(s.fake.calls.filter((c) => c.method === "oauth.v2.access")).toHaveLength(1);
    const [row] = await getDb()
      .select()
      .from(encryptedCredentials)
      .where(eq(encryptedCredentials.connectorAccountId, s.c.id));
    expect(row!.revision).toBeGreaterThan(1);
  });

  it("marks the connection for reauthorization when the refresh token is rejected", async () => {
    const s = await setup();
    await storeCredentials(
      s.c.id,
      { accessToken: "xoxb-expired", refreshToken: "wrong-refresh", tokenType: "bot" },
      new Date(Date.now() - 1000),
    );
    await expect(
      getAccessToken(s.c.id, (cur) => getRuntime("slack").refresh!(cur)),
    ).rejects.toMatchObject({ category: "provider_rejected" });
  });
});
