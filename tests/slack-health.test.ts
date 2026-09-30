import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { slackHealthTest } from "@/connectors/slack/runtime";
import type { RuntimeContext } from "@/connectors/types";
import { ConnectorError } from "@/connectors/errors";
import { connectAccount } from "@/server/connectors";
import { setResourceRule } from "@/server/policy";
import { listChannelChoices } from "@/server/slack-channels";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeSlack, type FakeSlackOptions } from "./fake-slack";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const ctx = (
  sl: ReturnType<typeof fakeSlack>,
  over: Partial<RuntimeContext> = {},
  meta: Record<string, unknown> = { senderMode: "bot", teamId: "T0123ABCDE" },
): RuntimeContext => ({
  account: {
    id: "a1",
    workspaceId: "w1",
    externalAccountId: "T0123ABCDE:bot",
    displayName: "Acme (app)",
    grantedScopes: ["chat:write"],
    metadata: meta,
  },
  getAccessToken: async () => sl.botToken,
  fetch: sl.sf,
  ...over,
});
const statuses = (r: { steps: { id: string; status: string }[] }) =>
  Object.fromEntries(r.steps.map((s) => [s.id, s.status]));

describe("Slack health test", () => {
  it("passes with five evidence steps and never posts", async () => {
    const sl = fakeSlack();
    const r = await slackHealthTest(ctx(sl));
    expect(r.overall).toBe("pass");
    expect(statuses(r)).toEqual({
      credential: "pass",
      reachability: "pass",
      identity: "pass",
      scopes: "pass",
      destinations: "pass",
    });
    expect(r.grantedScopes).toEqual(["chat:write", "channels:read", "groups:read"]);
    expect(sl.calls.map((c) => c.method)).not.toContain("chat.postMessage");
    expect(sl.messages).toHaveLength(0);
  });

  it("flags a revoked token as needing reauthorization", async () => {
    const sl = fakeSlack();
    const r = await slackHealthTest(ctx(sl, { getAccessToken: async () => "xoxb-revoked" }));
    expect(r.overall).toBe("fail");
    expect(r.authFailed).toBe(true);
    expect(statuses(r)).toMatchObject({ credential: "fail", identity: "skipped" });
  });

  it("reports an unreachable Slack without blaming the credential", async () => {
    const r = await slackHealthTest(ctx(fakeSlack({ statuses: { "api.test": 503 } })));
    expect(r.authFailed).toBeUndefined();
    expect(statuses(r)).toMatchObject({ reachability: "fail", credential: "skipped" });
  });

  it("does not treat rate limiting as a dead credential", async () => {
    const r = await slackHealthTest(ctx(fakeSlack({ statuses: { "auth.test": 429 } })));
    expect(r.overall).toBe("fail");
    expect(r.authFailed).toBe(false);
    expect(r.steps.find((s) => s.id === "credential")!.detail).toMatch(/rate limiting/);
  });

  it("detects a different workspace or a bot/user mix-up", async () => {
    const otherTeam = await slackHealthTest(
      ctx(fakeSlack({ authTestOverride: { team_id: "TELSEWHERE" } })),
    );
    expect(statuses(otherTeam).identity).toBe("fail");
    expect(otherTeam.identity).toBeUndefined();
    const notBot = await slackHealthTest(
      ctx(fakeSlack({ authTestOverride: { bot_id: undefined } })),
    );
    expect(statuses(notBot).identity).toBe("fail");
  });

  it("fails the permission step without chat:write and explains limited channel listing", async () => {
    const noPost = await slackHealthTest(ctx(fakeSlack({ scopes: "channels:read" })));
    expect(statuses(noPost).scopes).toBe("fail");
    const noList = await slackHealthTest(ctx(fakeSlack({ scopes: "chat:write" })));
    expect(noList.steps.find((s) => s.id === "scopes")!.detail).toMatch(
      /Channel listing is unavailable/,
    );
  });

  it("tells a bot with no channels to be invited, and is partial rather than healthy", async () => {
    const r = await slackHealthTest(
      ctx(fakeSlack({ channels: [{ id: "C0123456789", name: "ops", is_member: false }] })),
    );
    expect(r.overall).toBe("partial");
    expect(r.steps.find((s) => s.id === "destinations")!.detail).toMatch(/Invite it with \/invite/);
  });

  it("reports missing credentials cleanly", async () => {
    const sl = fakeSlack();
    const r = await slackHealthTest(
      ctx(sl, {
        getAccessToken: async () => {
          throw new ConnectorError("auth_expired", "none");
        },
      }),
    );
    expect(r.authFailed).toBe(true);
    expect(sl.calls).toHaveLength(0);
  });
});

async function setup(slack: FakeSlackOptions = {}) {
  const email = `sh${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Channels");
  const c = await connectAccount({
    workspaceId: ws.id,
    actorId: owner,
    provider: "slack",
    externalAccountId: "T0123ABCDE:bot",
    displayName: "Acme (app)",
    grantedScopes: ["chat:write", "channels:read", "groups:read"],
    metadata: { senderMode: "bot", teamId: "T0123ABCDE" },
    credentials: { accessToken: "xoxb-test-bot-token" },
  });
  return { owner, ws, c, sl: fakeSlack(slack) };
}

describe("channel access", () => {
  const channels = [
    { id: "C0000000001", name: "ops", is_member: true },
    { id: "C0000000002", name: "random", is_member: false },
    { id: "G0000000003", name: "leadership", is_private: true, is_member: true },
    { id: "C0000000004", name: "old", is_member: true, is_archived: true },
  ];

  it("lists only channels the connection belongs to (not archived), private ones included", async () => {
    const s = await setup({ channels });
    const { channels: out } = await listChannelChoices(s.owner, s.c.id, s.sl.sf);
    expect(out.map((c) => c.id).sort()).toEqual(["C0000000001", "G0000000003"]);
    expect(out.find((c) => c.id === "G0000000003")!.isPrivate).toBe(true);
    expect(s.sl.calls.every((c) => c.method === "conversations.list")).toBe(true);
  });

  it("marks which channels workspace policy permits", async () => {
    const s = await setup({ channels });
    await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000001",
      effect: "allow",
    });
    const { channels: out } = await listChannelChoices(s.owner, s.c.id, s.sl.sf);
    expect(Object.fromEntries(out.map((c) => [c.id, c.permitted]))).toEqual({
      C0000000001: true,
      G0000000003: false,
    });
    expect(out.find((c) => c.id === "G0000000003")!.reason).toBe("resource_not_allowed");
    await setResourceRule(s.owner, s.ws.id, {
      kind: "slack_channel",
      value: "C0000000001",
      effect: "block",
    });
    expect(
      (await listChannelChoices(s.owner, s.c.id, s.sl.sf)).channels.find(
        (c) => c.id === "C0000000001",
      )!.reason,
    ).toBe("resource_blocked");
  });

  it("is owner-only and hides other workspaces' connections", async () => {
    const s = await setup({ channels });
    const other = await setup({ channels });
    await expect(listChannelChoices(other.owner, s.c.id, s.sl.sf)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("surfaces missing channel-read permission as a typed error", async () => {
    const s = await setup({ errors: { "conversations.list": "missing_scope" } });
    await expect(listChannelChoices(s.owner, s.c.id, s.sl.sf)).rejects.toMatchObject({
      category: "scope_missing",
    });
  });
});
