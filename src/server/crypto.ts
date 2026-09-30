import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type Keyring = { active: number; keys: Map<number, Buffer> };

const KEY_VAR = /^CREDENTIAL_ENCRYPTION_KEY_V(\d+)$/;

/**
 * Loads versioned 32-byte keys (base64) from the environment. Keys never live in the database:
 * a database leak alone cannot decrypt credentials. Error messages name variables, not values.
 */
export function loadKeyring(source: Record<string, string | undefined> = process.env): Keyring {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(source)) {
    const m = KEY_VAR.exec(name);
    if (!m || !value) continue;
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) throw new Error(`${name} must be 32 random bytes, base64-encoded`);
    keys.set(Number(m[1]), key);
  }
  if (keys.size === 0) throw new Error("No CREDENTIAL_ENCRYPTION_KEY_V<n> is configured");
  const active = Number(source.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION ?? Math.max(...keys.keys()));
  if (!keys.has(active))
    throw new Error("CREDENTIAL_ENCRYPTION_ACTIVE_VERSION does not match a configured key");
  return { active, keys };
}

export type Sealed = { keyVersion: number; nonce: Buffer; ciphertext: Buffer };

/** AES-256-GCM. `aad` binds the ciphertext to its owner so rows cannot be swapped. */
export function seal(plaintext: string, aad: string, ring: Keyring = loadKeyring()): Sealed {
  const key = ring.keys.get(ring.active)!;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${aad}|v${ring.active}`));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { keyVersion: ring.active, nonce, ciphertext: Buffer.concat([enc, cipher.getAuthTag()]) };
}

export function open(sealed: Sealed, aad: string, ring: Keyring = loadKeyring()): string {
  const key = ring.keys.get(sealed.keyVersion);
  if (!key) throw new Error(`Encryption key version ${sealed.keyVersion} is not configured`);
  if (sealed.ciphertext.length < 16) throw new Error("Credential data is corrupt");
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
  decipher.setAAD(Buffer.from(`${aad}|v${sealed.keyVersion}`));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Credential could not be decrypted (wrong key, tampering or wrong owner)");
  }
}
