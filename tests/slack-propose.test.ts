import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDb } from "@/db/client";
import { auditEvents, proposalVersions, proposals, users } from "@/db/schema";
import { setTransportOverride } from "@/connectors/transport";
import { pingWarning, slackMessageArgs } from "@/connectors/capabilities/slack-message";
import { authenticateBearer } from "@/mcp/auth";
import { handleMcpRequest } from "@/mcp/http";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "@/mcp/metadata";
import { connectAccount } from "@/server/connectors";
import { editProposal } from "@/server/edits";
import { getProposalDetail } from "@/server/inbox";
import {
  createAuthorizationCode,
  createGrant,
  exchangeAuthorizationCode,
  getClient,
  pkceChallenge,
  registerClient,
} from "@/server/mcp-oauth";
import { setResourceRule, updateCapabilityPolicy } from "@/server/policy";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeSlack, type FakeSlackOptions } from "./fake-slack";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const channels = [
  { id: "C0000000001", name: "ops", is_member: true },
  { id: "C0000000002", name: "random", is_member: true },
  { id: "C0000000003", name: "lurking", is_member: false },
  { id: "C0000000004", name: "old", is_member: true, is_archived: true },
  { id: "G0000000005", name: "leadership", is_private: true, is_member: true },
];

async function setup(slack: FakeSlackOptions = {}, mode: "bot" | "user" = "bot") {
  const fake = fakeSlack({ channels, ...slack });
  setTransportOverride("slack", fake.sf);
  const email = `sp${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Slack Propose");
  await connectAccount({
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
  const reg = await registerClient({
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"],
  });
  const grant = await createGrant({
    clientDbId: (await getClient(reg.client_id))!.id,
    userId: owner,
    workspaceId: ws.id,
    scopes: ["proposals:create", "proposals:read"],
  });
  const verifier = randomBytes(48).toString("base64url");
  const code = await createAuthorizationCode({
    grantId: grant.id,
    redirectUri: "https://claude.ai/cb",
    codeChallenge: pkceChallenge(verifier),
    resource: mcpResourceUrl(),
  });
  const t = await exchangeAuthorizationCode({
    clientId: reg.client_id,
    code,
    redirectUri: "https://claude.ai/cb",
    codeVerifier: verifier,
  });
  const mcp = new Client({ name: "t", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(mcpResourceUrl()), {
      requestInit: { headers: { authorization: `Bearer ${t.access_token}` } },
      fetch: (i, init) =>
        handleMcpRequest(
          new Request(i as string, init),
          authenticateBearer,
          protectedResourceMetadataUrl(),
        ),
    }),
  );
  const aemail = `rv${Math.random()}@example.test`;
  await signInAs(aemail);
  const approver = (await getDb().select().from(users).where(eq(users.email, aemail)))[0]!.id;
  const { url } = await inviteMember(owner, ws.id, aemail, "approver");
  await acceptInvitation(approver, url.split("/invite/")[1]!);
  const propose = async (args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name: "slack.propose_message", arguments: args });
    return {
      isError: !!r.isError,
      out: (r.structuredContent ?? {}) as Record<string, any>,
      text: (r.content as { text: string }[])[0]!.text,
    };
  };
  return { fake, owner, approver, ws, propose };
}

describe("slack.propose_message", () => {
  it("resolves #name to the channel ID before policy, records the name for reviewers, and posts nothing", async () => {
    const s = await setup();
    const r = await s.propose({ channel: "#ops", text: "Deploy finished" });
    expect(r.isError).toBe(false);
    const id = r.out.proposal_id as string;
    const [v] = await getDb()
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, id));
    expect(v!.args).toMatchObject({ channel: "C0000000001", text: "Deploy finished" });
    expect(v!.destination).toBe("C0000000001");
    expect(v!.display).toMatchObject({
      channelName: "#ops",
      channelPrivacy: "public",
      workspace: "Acme",
    });
    expect(s.fake.messages).toHaveLength(0);
    expect(s.fake.calls.map((c) => c.method)).not.toContain("chat.postMessage");
    const d = await getProposalDetail(s.approver, s.ws.id, id);
    expect(d.destination).toBe("#ops · Acme");
    expect(d.fields.find((f) => f.label === "Channel")!.value).toBe("#ops (C0000000001)");
  });

  it("accepts a channel ID and a thread timestamp, and accepts names with or without #", async () => {
    const s = await setup();
    expect(
      (await s.propose({ channel: "C0000000001", text: "hi", thread_ts: "1700000000.000100" }))
        .isError,
    ).toBe(false);
    expect((await s.propose({ channel: "random", text: "hi" })).out.state).toBe("PENDING_APPROVAL");
    expect(
      (await s.propose({ channel: "C0000000001", text: "hi", thread_ts: "yesterday" })).isError,
    ).toBe(true);
  });

  it("does not reveal which channels exist when a name cannot be resolved", async () => {
    const s = await setup();
    const r = await s.propose({ channel: "#nonexistent", text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No channel named #nonexistent is available/);
    for (const name of ["ops", "random", "leadership", "lurking"])
      expect(r.text).not.toContain(name);
    expect(
      await getDb().select().from(proposals).where(eq(proposals.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });

  it("does not resolve channels the sender is not in, or that are archived", async () => {
    const s = await setup();
    expect((await s.propose({ channel: "#lurking", text: "hi" })).isError).toBe(true);
    expect((await s.propose({ channel: "#old", text: "hi" })).isError).toBe(true);
    const byId = await s.propose({ channel: "C0000000003", text: "hi" });
    expect(byId.text).toMatch(/not a member of #lurking\. Invite the app with \/invite/);
    expect((await s.propose({ channel: "C0000000004", text: "hi" })).text).toMatch(/archived/);
    expect((await s.propose({ channel: "C0000000999", text: "hi" })).text).toMatch(
      /not found, or this connection cannot see it/,
    );
  });

  it("marks private channels and tells a user-mode sender to join rather than invite the app", async () => {
    const s = await setup();
    const r = await s.propose({ channel: "#leadership", text: "hi" });
    const [v] = await getDb()
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, r.out.proposal_id));
    expect(v!.display).toMatchObject({ channelName: "🔒 leadership", channelPrivacy: "private" });
    const u = await setup({}, "user");
    expect((await u.propose({ channel: "C0000000003", text: "hi" })).text).toMatch(
      /You are not a member of #lurking\. Join the channel first/,
    );
  });

  it("states truthfully who the message will appear from", async () => {
    const bot = await setup();
    const b = await getProposalDetail(
      bot.approver,
      bot.ws.id,
      (await bot.propose({ channel: "#ops", text: "hi" })).out.proposal_id,
    );
    expect(b.senderNote).toMatch(/appear from the app \(bot\), not from a person/);
    const user = await setup({}, "user");
    const u = await getProposalDetail(
      user.approver,
      user.ws.id,
      (await user.propose({ channel: "#ops", text: "hi" })).out.proposal_id,
    );
    expect(u.senderNote).toMatch(/appear as maya/);
  });

  it("degrades gracefully when Slack is down: IDs are accepted as unverified, names cannot be resolved", async () => {
    const s = await setup({ statuses: { "conversations.list": 503, "conversations.info": 503 } });
    const byId = await s.propose({ channel: "C0000000001", text: "hi" });
    expect(byId.isError).toBe(false);
    const audit = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, byId.out.proposal_id));
    expect(audit.find((a) => a.action === "proposal.created")!.detail).toMatchObject({
      destination_check: "unverified",
    });
    const byName = await s.propose({ channel: "#ops", text: "hi" });
    expect(byName.isError).toBe(true);
    expect(byName.text).toMatch(/could not resolve #ops right now/);
  });

  it("asks for reconnection when Slack rejects the stored token", async () => {
    const s = await setup();
    // Slack now only accepts a different token: the stored one has been revoked.
    setTransportOverride("slack", fakeSlack({ channels, botToken: "xoxb-rotated-elsewhere" }).sf);
    const r = await s.propose({ channel: "C0000000001", text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs to be reconnected/);
  });

  it("applies channel allow/block rules to the RESOLVED ID", async () => {
    const s = await setup();
    await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000001",
      effect: "allow",
    });
    expect((await s.propose({ channel: "#ops", text: "hi" })).isError).toBe(false);
    const denied = await s.propose({ channel: "#random", text: "hi" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/allowed list/);
  });

  it("warns reviewers about mass pings and mentions", () => {
    expect(pingWarning("Heads up <!channel> deploy")).toMatch(/everyone in the channel/);
    expect(pingWarning("<!here|here> now")).toMatch(/everyone in the channel/);
    expect(pingWarning("<!subteam^S0123|@oncall> please look")).toMatch(/everyone in the channel/);
    expect(pingWarning("thanks <@U0123ABC>")).toMatch(/mentions specific people/);
    expect(pingWarning("Plain text with @channel typed literally")).toBeUndefined();
  });

  it("surfaces the ping warning on the review screen", async () => {
    const s = await setup();
    const id = (await s.propose({ channel: "#ops", text: "Release now <!channel>" })).out
      .proposal_id;
    const d = await getProposalDetail(s.approver, s.ws.id, id);
    expect(d.fields.find((f) => f.label === "Message")!.warning).toMatch(/notify everyone/);
  });

  it("re-resolves and re-validates an edit that changes the channel", async () => {
    const s = await setup();
    const id = (await s.propose({ channel: "#ops", text: "hi" })).out.proposal_id;
    await editProposal({
      actorId: s.approver,
      workspaceId: s.ws.id,
      proposalId: id,
      expectedVersion: 1,
      args: { channel: "#random", text: "hi" },
    });
    const d = await getProposalDetail(s.approver, s.ws.id, id);
    expect(d.args).toMatchObject({ channel: "C0000000002" });
    expect(d.destination).toBe("#random · Acme");
    await expect(
      editProposal({
        actorId: s.approver,
        workspaceId: s.ws.id,
        proposalId: id,
        expectedVersion: 2,
        args: { channel: "C0000000003", text: "hi" },
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("validates arguments strictly", () => {
    for (const bad of [
      { channel: "#Ops Team", text: "x" },
      { channel: "", text: "x" },
      { channel: "#ops", text: "" },
      { channel: "#ops", text: "x".repeat(4001) },
      { channel: "C0000000001;drop", text: "x" },
    ]) {
      expect(slackMessageArgs.safeParse(bad).success).toBe(false);
    }
    expect(slackMessageArgs.parse({ channel: "#ops", text: "  hi  " }).text).toBe("hi");
  });
});
