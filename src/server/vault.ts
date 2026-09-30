import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { encryptedCredentials } from "@/db/schema";
import { loadKeyring, open, seal } from "./crypto";
import type { Executor } from "./audit";

export type StoredCredentials = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  /** Extra provider secrets (e.g. a Slack user token alongside the bot token). */
  extra?: Record<string, string>;
};

const aadFor = (connectorAccountId: string) => `cred:${connectorAccountId}`;

export async function storeCredentials(
  connectorAccountId: string,
  creds: StoredCredentials,
  accessExpiresAt: Date | null = null,
  exec: Executor = getDb(),
) {
  const sealed = seal(JSON.stringify(creds), aadFor(connectorAccountId));
  await exec
    .insert(encryptedCredentials)
    .values({
      connectorAccountId,
      keyVersion: sealed.keyVersion,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      accessExpiresAt,
    })
    .onConflictDoUpdate({
      target: encryptedCredentials.connectorAccountId,
      set: {
        keyVersion: sealed.keyVersion,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        accessExpiresAt,
        revision: sql`${encryptedCredentials.revision} + 1`,
        updatedAt: new Date(),
      },
    });
}

export async function loadCredentials(connectorAccountId: string, exec: Executor = getDb()) {
  const [row] = await exec
    .select()
    .from(encryptedCredentials)
    .where(eq(encryptedCredentials.connectorAccountId, connectorAccountId));
  if (!row) return null;
  const json = open(
    { keyVersion: row.keyVersion, nonce: row.nonce, ciphertext: row.ciphertext },
    aadFor(connectorAccountId),
  );
  return {
    credentials: JSON.parse(json) as StoredCredentials,
    revision: row.revision,
    accessExpiresAt: row.accessExpiresAt,
  };
}

export async function deleteCredentials(connectorAccountId: string, exec: Executor = getDb()) {
  await exec
    .delete(encryptedCredentials)
    .where(eq(encryptedCredentials.connectorAccountId, connectorAccountId));
}

/** Re-encrypts every credential under the active key version. Returns how many rows moved. */
export async function rotateAllCredentials(): Promise<number> {
  const ring = loadKeyring();
  const db = getDb();
  const rows = await db.select().from(encryptedCredentials);
  let moved = 0;
  for (const row of rows) {
    if (row.keyVersion === ring.active) continue;
    const plain = open(
      { keyVersion: row.keyVersion, nonce: row.nonce, ciphertext: row.ciphertext },
      aadFor(row.connectorAccountId),
      ring,
    );
    const next = seal(plain, aadFor(row.connectorAccountId), ring);
    await db
      .update(encryptedCredentials)
      .set({
        keyVersion: next.keyVersion,
        nonce: next.nonce,
        ciphertext: next.ciphertext,
        revision: sql`${encryptedCredentials.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(encryptedCredentials.connectorAccountId, row.connectorAccountId));
    moved++;
  }
  return moved;
}
