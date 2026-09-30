import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random secret with 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Only hashes of bearer secrets (invites, codes, tokens) are persisted. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
