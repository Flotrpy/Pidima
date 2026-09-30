import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, encryptedCredentials, users } from "@/db/schema";
import { loadKeyring, open, seal } from "@/server/crypto";
import {
  deleteCredentials,
  loadCredentials,
  rotateAllCredentials,
  storeCredentials,
} from "@/server/vault";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const b64 = () => randomBytes(32).toString("base64");

describe("crypto helpers", () => {
  const ring = loadKeyring({
    CREDENTIAL_ENCRYPTION_KEY_V1: b64(),
    CREDENTIAL_ENCRYPTION_KEY_V2: b64(),
  });

  it("round-trips and never repeats a nonce", () => {
    const a = seal("secret", "aad", ring);
    const b = seal("secret", "aad", ring);
    expect(open(a, "aad", ring)).toBe("secret");
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.keyVersion).toBe(2);
  });

  it("rejects tampering, a different owner and the wrong key", () => {
    const s = seal("secret", "owner-1", ring);
    const flipped = Buffer.from(s.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => open({ ...s, ciphertext: flipped }, "owner-1", ring)).toThrow(
      /could not be decrypted/,
    );
    expect(() => open(s, "owner-2", ring)).toThrow(/could not be decrypted/);
    const other = loadKeyring({ CREDENTIAL_ENCRYPTION_KEY_V2: b64() });
    expect(() => open(s, "owner-1", other)).toThrow();
  });

  it("validates configuration without echoing key material", () => {
    expect(() => loadKeyring({})).toThrow(/No CREDENTIAL_ENCRYPTION_KEY/);
    const bad = "short-secret-value";
    expect(() => loadKeyring({ CREDENTIAL_ENCRYPTION_KEY_V1: bad })).toThrow(/32 random bytes/);
    expect(() => loadKeyring({ CREDENTIAL_ENCRYPTION_KEY_V1: bad })).not.toThrow(new RegExp(bad));
    expect(() =>
      loadKeyring({
        CREDENTIAL_ENCRYPTION_KEY_V1: b64(),
        CREDENTIAL_ENCRYPTION_ACTIVE_VERSION: "3",
      }),
    ).toThrow(/ACTIVE_VERSION/);
  });
});

describe("credential vault", () => {
  async function account() {
    await signInAs(`v${Math.random()}@example.test`);
    const [u] = await getDb().select().from(users).limit(1).orderBy(users.createdAt);
    const ws = await createWorkspace(u!.id, "Vault");
    const [c] = await getDb()
      .insert(connectorAccounts)
      .values({
        workspaceId: ws.id,
        provider: "github",
        externalAccountId: `${Math.random()}`,
        displayName: "gh",
        connectedByUserId: u!.id,
      })
      .returning();
    return c!;
  }

  it("stores ciphertext only and loads it back", async () => {
    const c = await account();
    await storeCredentials(c.id, { accessToken: "gho_supersecret", refreshToken: "r1" });
    const [raw] = await getDb()
      .select()
      .from(encryptedCredentials)
      .where(eq(encryptedCredentials.connectorAccountId, c.id));
    expect(raw!.ciphertext.toString("utf8")).not.toContain("gho_supersecret");
    expect(raw!.ciphertext.toString("base64")).not.toContain("gho_supersecret");
    const loaded = await loadCredentials(c.id);
    expect(loaded?.credentials).toEqual({ accessToken: "gho_supersecret", refreshToken: "r1" });
    expect(loaded?.revision).toBe(1);
  });

  it("bumps the revision on update and refuses a ciphertext moved to another account", async () => {
    const a = await account();
    const b = await account();
    await storeCredentials(a.id, { accessToken: "a1" });
    await storeCredentials(a.id, { accessToken: "a2" });
    expect((await loadCredentials(a.id))?.revision).toBe(2);

    await storeCredentials(b.id, { accessToken: "b1" });
    const [rawA] = await getDb()
      .select()
      .from(encryptedCredentials)
      .where(eq(encryptedCredentials.connectorAccountId, a.id));
    await getDb()
      .update(encryptedCredentials)
      .set({ nonce: rawA!.nonce, ciphertext: rawA!.ciphertext, keyVersion: rawA!.keyVersion })
      .where(eq(encryptedCredentials.connectorAccountId, b.id));
    await expect(loadCredentials(b.id)).rejects.toThrow(/could not be decrypted/);
  });

  it("deletes credentials", async () => {
    const c = await account();
    await storeCredentials(c.id, { accessToken: "x" });
    await deleteCredentials(c.id);
    expect(await loadCredentials(c.id)).toBeNull();
  });

  it("rotates rows to the active key version", async () => {
    const c = await account();
    await storeCredentials(c.id, { accessToken: "rot" });
    // Simulate an old key: re-seal under a different version via direct ring override.
    const old = loadKeyring({
      CREDENTIAL_ENCRYPTION_KEY_V7: Buffer.alloc(32, 9).toString("base64"),
    });
    const sealed = seal(JSON.stringify({ accessToken: "rot" }), `cred:${c.id}`, old);
    process.env.CREDENTIAL_ENCRYPTION_KEY_V7 = Buffer.alloc(32, 9).toString("base64");
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = "7";
    try {
      await getDb()
        .update(encryptedCredentials)
        .set({ keyVersion: 7, nonce: sealed.nonce, ciphertext: sealed.ciphertext })
        .where(eq(encryptedCredentials.connectorAccountId, c.id));
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = "1";
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_V7;
      // V7 is gone, so rotation must fail loudly rather than lose data.
      await expect(rotateAllCredentials()).rejects.toThrow(/not configured/);
      process.env.CREDENTIAL_ENCRYPTION_KEY_V7 = Buffer.alloc(32, 9).toString("base64");
      expect(await rotateAllCredentials()).toBeGreaterThanOrEqual(1);
      expect((await loadCredentials(c.id))?.credentials.accessToken).toBe("rot");
      const [row] = await getDb()
        .select()
        .from(encryptedCredentials)
        .where(eq(encryptedCredentials.connectorAccountId, c.id));
      expect(row!.keyVersion).toBe(1);
    } finally {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_V7;
      delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    }
  });
});
