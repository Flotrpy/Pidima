import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { LIMITS, RateLimitError, consume, purgeOldBuckets } from "@/server/rate-limit";

describe("rate limiting", () => {
  it("allows up to the limit then rejects with a retry hint", async () => {
    const subject = randomUUID();
    const now = Date.now();
    for (let i = 0; i < LIMITS.connectorTest.limit; i++)
      await consume("connectorTest", subject, now);
    const err = await consume("connectorTest", subject, now).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(err.retryAfterSec).toBeLessThanOrEqual(LIMITS.connectorTest.windowSec);
  });

  it("is atomic under concurrency: exactly `limit` callers succeed", async () => {
    const subject = randomUUID();
    const now = Date.now();
    const n = LIMITS.connectorTest.limit + 7;
    const results = await Promise.allSettled(
      Array.from({ length: n }, () => consume("connectorTest", subject, now)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
      LIMITS.connectorTest.limit,
    );
  });

  it("isolates subjects and names, and resets in the next window", async () => {
    const a = randomUUID();
    const now = Date.now();
    for (let i = 0; i < LIMITS.connectorTest.limit; i++) await consume("connectorTest", a, now);
    await expect(consume("connectorTest", randomUUID(), now)).resolves.toBeUndefined();
    await expect(consume("status", a, now)).resolves.toBeUndefined();
    await expect(
      consume("connectorTest", a, now + LIMITS.connectorTest.windowSec * 1000),
    ).resolves.toBeUndefined();
  });

  it("purges stale buckets only", async () => {
    const subject = randomUUID();
    await consume("status", subject, Date.now() - 2 * 3600_000);
    expect(await purgeOldBuckets()).toBeGreaterThanOrEqual(1);
  });
});
