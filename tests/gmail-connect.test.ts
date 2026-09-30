import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, encryptedCredentials, users } from "@/db/schema";
import { codeChallengeFor, codeVerifierFor } from "@/server/oauth-tx";
import { completeGmailConnect, startGmailConnect } from "@/server/gmail-connect";
import { loadCredentials } from "@/server/vault";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { fakeGmail, type FakeGmailOptions } from "./fake-gmail";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function setup() {
  const email = `gm${Math.random()}@example.test`;
  await signInAs(email);
  const owner = (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
  return { owner, ws: await createWorkspace(owner, "Gmail") };
}
const st = (u: string) => new URL(u).searchParams.get("state")!;
const run = async (g: FakeGmailOptions = {}, s?: Awaited<ReturnType<typeof setup>>) => {
  const w = s ?? (await setup());
  const url = await startGmailConnect({ userId: w.owner, workspaceId: w.ws.id });
  return {
    w,
    url,
    r: await completeGmailConnect(
      { userId: w.owner, state: st(url), code: "good-code", error: null },
      fakeGmail(g).sf,
    ),
  };
};

describe("Gmail authorize URL", () => {
  it("asks only for send + identity with PKCE and offline access, and never includes the secret", async () => {
    const s = await setup();
    const u = new URL(await startGmailConnect({ userId: s.owner, workspaceId: s.ws.id }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/gmail.send",
    );
    expect(u.searchParams.get("scope")).not.toMatch(/readonly|modify|compose|mail\.google\.com/);
    expect(u.searchParams.get("code_challenge")).toBe(
      codeChallengeFor(codeVerifierFor(st(u.toString()))),
    );
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/connectors/gmail/callback",
    );
    expect(u.toString()).not.toContain("g-client-secret");
  });
});

describe("Gmail callback", () => {
  it("connects the verified sender address with scope evidence and encrypted tokens", async () => {
    const { r } = await run();
    const [c] = await getDb()
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, r.connectorAccountId));
    expect(c).toMatchObject({
      provider: "gmail",
      externalAccountId: "1234567890",
      displayName: "maya@acme.com",
      status: "active",
    });
    expect(c!.grantedScopes).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(c!.metadata).toMatchObject({
      email: "maya@acme.com",
      senderAddresses: ["maya@acme.com"],
    });
    const [raw] = await getDb()
      .select()
      .from(encryptedCredentials)
      .where(eq(encryptedCredentials.connectorAccountId, c!.id));
    expect(raw!.ciphertext.toString("utf8")).not.toContain("ya29");
    const cred = await loadCredentials(c!.id);
    expect(cred?.credentials).toMatchObject({
      accessToken: "ya29.test-access",
      refreshToken: "r-1",
    });
    expect(cred?.accessExpiresAt).toBeInstanceOf(Date);
    expect(JSON.stringify(c)).not.toContain("ya29");
  });

  it("reconnects the same Google account in place", async () => {
    const a = await run();
    const b = await run({ accessToken: "ya29.new" }, a.w);
    expect(b.r.connectorAccountId).toBe(a.r.connectorAccountId);
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, a.w.ws.id)),
    ).toHaveLength(1);
  });

  it("refuses connections that could not work: no send scope, no refresh token, unverified email", async () => {
    const w = await setup();
    for (const [g, code] of [
      [{ scope: "openid email" }, "insufficient_scope"],
      [{ refreshToken: null }, "no_refresh"],
      [{ emailVerified: false }, "unverified_email"],
    ] as const) {
      await expect(run(g, w)).rejects.toMatchObject({ code });
    }
    expect(
      await getDb()
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.workspaceId, w.ws.id)),
    ).toHaveLength(0);
  });

  it("rejects replayed, forged and cross-user callbacks before contacting Google, and handles denial", async () => {
    const s = await setup();
    const other = await setup();
    const url = await startGmailConnect({ userId: s.owner, workspaceId: s.ws.id });
    const g = fakeGmail();
    await expect(
      completeGmailConnect(
        { userId: other.owner, state: st(url), code: "good-code", error: null },
        g.sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      completeGmailConnect(
        { userId: s.owner, state: "forged", code: "good-code", error: null },
        g.sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(g.calls).toHaveLength(0);
    await expect(
      completeGmailConnect(
        { userId: s.owner, state: st(url), code: null, error: "access_denied" },
        g.sf,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      completeGmailConnect(
        { userId: s.owner, state: st(url), code: "good-code", error: null },
        g.sf,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("maps a rejected code to a generic failure", async () => {
    const s = await setup();
    const url = await startGmailConnect({ userId: s.owner, workspaceId: s.ws.id });
    await expect(
      completeGmailConnect(
        { userId: s.owner, state: st(url), code: "bad", error: null },
        fakeGmail().sf,
      ),
    ).rejects.toMatchObject({ code: "failed" });
  });
});
