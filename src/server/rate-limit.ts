import "server-only";
import { lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { rateLimitBuckets } from "@/db/schema";

export class RateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`Too many requests. Try again in ${retryAfterSec}s.`);
  }
}

/** Named limits (per key, per window). Tuned for humans and well-behaved agents, not for abuse. */
export const LIMITS = {
  propose: { limit: 60, windowSec: 60 },
  status: { limit: 120, windowSec: 60 },
  decide: { limit: 60, windowSec: 60 },
  connectorTest: { limit: 10, windowSec: 60 },
  execute: { limit: 120, windowSec: 60 },
  oauthToken: { limit: 60, windowSec: 60 },
} as const;
export type LimitName = keyof typeof LIMITS;

/**
 * Fixed-window counter in Postgres, so the limit holds across every server instance. The increment
 * is one atomic upsert; there is no read-then-write race.
 */
export async function consume(name: LimitName, subject: string, now = Date.now()): Promise<void> {
  const { limit, windowSec } = LIMITS[name];
  const windowStart = new Date(Math.floor(now / (windowSec * 1000)) * windowSec * 1000);
  const [row] = await getDb()
    .insert(rateLimitBuckets)
    .values({ key: `${name}:${subject}`, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });
  if ((row?.count ?? 0) > limit)
    throw new RateLimitError(
      Math.max(1, Math.ceil((windowStart.getTime() + windowSec * 1000 - now) / 1000)),
    );
}

export async function purgeOldBuckets(now = Date.now()): Promise<number> {
  const rows = await getDb()
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.windowStart, new Date(now - 3600_000)))
    .returning({ k: rateLimitBuckets.key });
  return rows.length;
}
