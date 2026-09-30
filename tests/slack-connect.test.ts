import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  auditEvents,
  connectorAccounts,
  encryptedCredentials,
  oauthTransactions,
  users,
} from "@/db/schema";
import { buildAuthorizeUrl } from "@/connectors/slack/oauth";
import { isSenderMode, slackErrorCategory } from "@/connectors/slack/api";
import { SlackConnectError, completeSlackConnect, startSlackConnect } from "@/server/slack-connect";
import { loadCredentials } from "@/server/vault";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeSlack, type FakeSlackOptions } from "./fake-slack";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup() {
  const email = `sl${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  const ws = await createWorkspace(owner, "Slack");
  return { owner, ws };
}
const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;
async function connect(
  mode: "bot" | "user",
  slack: FakeSlackOptions = {},
  s?: Awaited<ReturnType<typeof setup>>,
) {
  const w = s ?? (await setup());
  const url = await startSlackConnect({ userId: w.owner, workspaceId: w.ws.id, mode });
  const fake = fakeSlack({ install: mode, ...slack });
  const r = await completeSlackConnect(
    { userId: w.owner, state: stateFrom(url), code: "good-code", error: null },
    fake.sf,
  );
  return { w, fake, r };
}

describe("Slack authorize URL", () => {
  it("requests bot scopes for the app, or only user scopes for a person, never broader than needed", async () => {
    const s = await setup();
    const bot = new URL(
      await startSlackConnect({ userId: s.owner, workspaceId: s.ws.id, mode: "bot" }),
    );
    expect(bot.origin + bot.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(bot.searchParams.get("scope")).toBe("chat:write,channels:read,groups:read");
    expect(bot.searchParams.get("user_scope")).toBeNull();
    expect(bot.searchParams.get("client_id")).toBe("slack-client-id");
    expect(bot.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/connectors/slack/callback",
    );
    expect(bot.toString()).not.toContain("slack-client-secret");
    expect(bot.searchParams.get("scope")).not.toContain("chat:write.public");

    const user = new URL(
      await startSlackConnect({ userId: s.owner, workspaceId: s.ws.id, mode: "user" }),
    );
    expect(user.searchParams.get("user_scope")).toBe("chat:write,channels:read,groups:read");
    expect(user.searchParams.get("scope")).toBeNull();
    expect(
      buildAuthorizeUrl({ clientId: "c", redirectUri: "https://x/cb", state: "s", mode: "bot" }),
    ).toContain("state=s");
  });

  it("keeps the sender mode server-side where the browser cannot change it", async () => {
    const s = await setup();
    const url = await startSlackConnect({ userId: s.owner, workspaceId: s.ws.id, mode: "user" });
    const rows = await getDb()
      .select()
      .from(oauthTransactions)
      .where(eq(oauthTransactions.userId, s.owner));
    expect(rows.at(-1)!.context).toEqual({ senderMode: "user" });
    // Completing with a bot-shaped response is refused: the transaction says "user".
    const fake = fakeSlack({ install: "bot" });
    await expect(
      completeSlackConnect(
        { userId: s.owner, state: stateFrom(url), code: "good-code", error: null },
        fake.sf,
      ),
    ).rejects.toMatchObject({ code: "failed" });
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });
});

describe("Slack callback", () => {
  it("connects the app (bot) identity with verified team, scope evidence and encrypted token", async () => {
    const { w, r } = await connect("bot");
    const [c] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, r.connectorAccountId));
    expect(c).toMatchObject({
      provider: "slack",
      externalAccountId: "T0123ABCDE:bot",
      displayName: "Acme (app)",
      status: "active",
      grantedScopes: ["chat:write", "channels:read", "groups:read"],
      workspaceId: w.ws.id,
    });
    expect(c!.metadata).toMatchObject({
      senderMode: "bot",
      teamId: "T0123ABCDE",
      teamName: "Acme",
      botUserId: "UBOT12345",
    });
    expect(JSON.stringify(c)).not.toContain("xoxb-");
    const [raw] = await getDb()
      .select()
      .from(encryptedCredentials)
      .where(eq(encryptedCredentials.connectorAccountId, c!.id));
    expect(raw!.ciphertext.toString("utf8")).not.toContain("xoxb-");
    expect((await loadCredentials(c!.id))?.credentials).toMatchObject({
      accessToken: "xoxb-test-bot-token",
      tokenType: "bot",
    });
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.subjectId, c!.id));
    expect(JSON.stringify(audit)).not.toContain("xoxb");
  });

  it("connects a person (user token) as a separate sender, never mixed up with the bot", async () => {
    const s = await setup();
    const a = await connect("bot", {}, s);
    const b = await connect("user", {}, s);
    expect(b.r.connectorAccountId).not.toBe(a.r.connectorAccountId);
    const [u] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, b.r.connectorAccountId));
    expect(u).toMatchObject({
      externalAccountId: "T0123ABCDE:user:U0MAYA123",
      displayName: "Acme (as maya)",
    });
    expect(u!.metadata).toMatchObject({ senderMode: "user", userId: "U0MAYA123" });
    expect((await loadCredentials(u!.id))?.credentials.accessToken).toBe("xoxp-test-user-token");
  });

  it("handles reinstall by updating the same connection in place", async () => {
    const s = await setup();
    const a = await connect("bot", {}, s);
    const b = await connect("bot", { botToken: "xoxb-new-token-after-reinstall" }, s);
    expect(b.r.connectorAccountId).toBe(a.r.connectorAccountId);
    expect((await loadCredentials(a.r.connectorAccountId))?.credentials.accessToken).toBe(
      "xoxb-new-token-after-reinstall",
    );
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, s.ws.id)),
    ).toHaveLength(1);
  });

  it("keeps a rotating refresh token and expiry when Slack issues them", async () => {
    const { r } = await connect("bot", { refreshable: true });
    const c = await loadCredentials(r.connectorAccountId);
    expect(c?.credentials.refreshToken).toBe("refresh-1");
    expect(c?.accessExpiresAt).toBeInstanceOf(Date);
  });

  it("rejects replayed, forged and cross-user callbacks before contacting Slack", async () => {
    const s = await setup();
    const other = await setup();
    const url = await startSlackConnect({ userId: s.owner, workspaceId: s.ws.id, mode: "bot" });
    const fake = fakeSlack();
    await expect(
      completeSlackConnect(
        { userId: other.owner, state: stateFrom(url), code: "good-code", error: null },
        fake.sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      completeSlackConnect(
        { userId: s.owner, state: "forged", code: "good-code", error: null },
        fake.sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(fake.calls).toHaveLength(0);
    await completeSlackConnect(
      { userId: s.owner, state: stateFrom(url), code: "good-code", error: null },
      fake.sf,
    );
    await expect(
      completeSlackConnect(
        { userId: s.owner, state: stateFrom(url), code: "good-code", error: null },
        fakeSlack().sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("handles a user who declines, a bad code and missing chat:write without connecting", async () => {
    const s = await setup();
    const begin = async () =>
      stateFrom(await startSlackConnect({ userId: s.owner, workspaceId: s.ws.id, mode: "bot" }));
    await expect(
      completeSlackConnect(
        { userId: s.owner, state: await begin(), code: null, error: "access_denied" },
        fakeSlack().sf,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      completeSlackConnect(
        { userId: s.owner, state: await begin(), code: "wrong", error: null },
        fakeSlack().sf,
      ),
    ).rejects.toMatchObject({ code: "failed" });
    await expect(
      completeSlackConnect(
        { userId: s.owner, state: await begin(), code: "good-code", error: null },
        fakeSlack({ scopes: "channels:read" }).sf,
      ),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, s.ws.id)),
    ).toHaveLength(0);
  });

  it("refuses a token whose verified identity does not match the install", async () => {
    const teamMismatch = await connect("bot", {
      authTestOverride: { team_id: "TOTHERTEAM" },
    }).catch((e) => e);
    expect(teamMismatch).toBeInstanceOf(SlackConnectError);
    expect(teamMismatch.code).toBe("wrong_identity");
    const notABot = await connect("bot", { authTestOverride: { bot_id: undefined } }).catch(
      (e) => e,
    );
    expect(notABot.code).toBe("wrong_identity");
  });
});

describe("Slack error mapping", () => {
  it("maps Slack error codes to categories and treats unknown codes as rejections", () => {
    expect(slackErrorCategory("token_revoked").category).toBe("auth_expired");
    expect(slackErrorCategory("missing_scope").category).toBe("scope_missing");
    expect(slackErrorCategory("not_in_channel").category).toBe("destination_inaccessible");
    expect(slackErrorCategory("is_archived").category).toBe("destination_inaccessible");
    expect(slackErrorCategory("ratelimited").category).toBe("rate_limited");
    expect(slackErrorCategory("internal_error").category).toBe("provider_unavailable");
    expect(slackErrorCategory("msg_too_long").category).toBe("provider_rejected");
    expect(slackErrorCategory(undefined).category).toBe("provider_rejected");
    expect(isSenderMode("bot")).toBe(true);
    expect(isSenderMode("admin")).toBe(false);
  });
});
