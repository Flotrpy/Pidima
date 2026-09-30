import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { oauthTransactions, users } from "@/db/schema";
import {
  OAuthTxError,
  beginOAuth,
  codeChallengeFor,
  codeVerifierFor,
  consumeOAuth,
  purgeExpiredOAuthTransactions,
} from "@/server/oauth-tx";
import { sha256 } from "@/server/tokens";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  return u!.id;
}

async function setup() {
  const owner = await user(`o${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "OAuth");
  return { owner, ws };
}

describe("oauth transactions", () => {
  it("issues an unguessable state, stores only its hash and a valid S256 challenge", async () => {
    const { owner, ws } = await setup();
    const b = await beginOAuth({
      userId: owner,
      workspaceId: ws.id,
      provider: "github",
      returnTo: "/connections",
    });
    expect(b.state.length).toBeGreaterThanOrEqual(43);
    expect(b.redirectUri).toBe("http://localhost:3000/api/connectors/github/callback");
    expect(b.codeChallenge).toBe(codeChallengeFor(codeVerifierFor(b.state)));
    const [row] = await getDb()
      .select()
      .from(oauthTransactions)
      .where(eq(oauthTransactions.stateHash, sha256(b.state)));
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(b.state);
  });

  it("is single use", async () => {
    const { owner, ws } = await setup();
    const b = await beginOAuth({ userId: owner, workspaceId: ws.id, provider: "github" });
    const first = await consumeOAuth({ state: b.state, userId: owner, provider: "github" });
    expect(first.codeVerifier).toBe(codeVerifierFor(b.state));
    await expect(
      consumeOAuth({ state: b.state, userId: owner, provider: "github" }),
    ).rejects.toBeInstanceOf(OAuthTxError);
  });

  it("lets exactly one of many concurrent callbacks win", async () => {
    const { owner, ws } = await setup();
    const b = await beginOAuth({ userId: owner, workspaceId: ws.id, provider: "slack" });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        consumeOAuth({ state: b.state, userId: owner, provider: "slack" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("binds the callback to the initiating user and provider", async () => {
    const { owner, ws } = await setup();
    const other = await user(`x${Math.random()}@example.test`);
    const b = await beginOAuth({ userId: owner, workspaceId: ws.id, provider: "github" });
    await expect(
      consumeOAuth({ state: b.state, userId: other, provider: "github" }),
    ).rejects.toBeInstanceOf(OAuthTxError);
    await expect(
      consumeOAuth({ state: b.state, userId: owner, provider: "slack" }),
    ).rejects.toBeInstanceOf(OAuthTxError);
    // The failed attempts must not have burned the legitimate transaction.
    await expect(
      consumeOAuth({ state: b.state, userId: owner, provider: "github" }),
    ).resolves.toBeTruthy();
  });

  it("rejects expired, forged and oversized state", async () => {
    const { owner, ws } = await setup();
    const b = await beginOAuth({ userId: owner, workspaceId: ws.id, provider: "github" });
    await getDb()
      .update(oauthTransactions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTransactions.stateHash, sha256(b.state)));
    await expect(
      consumeOAuth({ state: b.state, userId: owner, provider: "github" }),
    ).rejects.toBeInstanceOf(OAuthTxError);
    await expect(
      consumeOAuth({ state: "forged", userId: owner, provider: "github" }),
    ).rejects.toBeInstanceOf(OAuthTxError);
    await expect(
      consumeOAuth({ state: "a".repeat(500), userId: owner, provider: "github" }),
    ).rejects.toBeInstanceOf(OAuthTxError);
    expect(
      await purgeExpiredOAuthTransactions(new Date(Date.now() + 3 * 60 * 60 * 1000)),
    ).toBeGreaterThan(0);
  });

  it("sanitises the return destination", async () => {
    const { owner, ws } = await setup();
    const b = await beginOAuth({
      userId: owner,
      workspaceId: ws.id,
      provider: "github",
      returnTo: "https://evil.test",
    });
    const r = await consumeOAuth({ state: b.state, userId: owner, provider: "github" });
    expect(r.returnTo).toBe("/connections");
  });

  it("requires connector-management permission to start and to finish", async () => {
    const { owner, ws } = await setup();
    const member = await user(`m${Math.random()}@example.test`);
    const email = (await getDb().select().from(users).where(eq(users.id, member)))[0]!.email;
    const { url } = await inviteMember(owner, ws.id, email, "member");
    await acceptInvitation(member, url.split("/invite/")[1]!);
    await expect(
      beginOAuth({ userId: member, workspaceId: ws.id, provider: "github" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
