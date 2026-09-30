import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorError } from "./errors";
import { categorizeStatus, createSafeFetch, retryAfterMs, safeFetchFor } from "./transport";

let server: http.Server;
let origin: string;
let hits: Record<string, number> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/ok") return void res.end(JSON.stringify({ ok: true }));
    if (path === "/slow") return void setTimeout(() => res.end("late"), 1000);
    if (path === "/big") return void res.end("x".repeat(5000));
    if (path === "/redirect")
      return void res.writeHead(302, { location: "http://evil.test/" }).end();
    if (path === "/flaky") {
      if (hits[path]! < 3) return void res.writeHead(503, { "retry-after": "0" }).end();
      return void res.end("recovered");
    }
    if (path === "/limited") return void res.writeHead(429, { "retry-after": "120" }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const sf = (over = {}) =>
  createSafeFetch({ allowedOrigins: [origin], sleep: async () => {}, ...over });

describe("safe transport", () => {
  it("only talks to fixed origins and never echoes the URL in errors", async () => {
    const f = sf();
    const err = await f("https://evil.test/steal?token=secret").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.message).not.toContain("secret");
    await expect(f("https://user:pw@api.github.com/x")).rejects.toBeInstanceOf(ConnectorError);
    await expect(f("not a url")).rejects.toBeInstanceOf(ConnectorError);
  });

  it("exposes fixed production origins per provider and rejects lookalikes", async () => {
    const f = safeFetchFor("github", { fetchImpl: async () => new Response("{}") });
    await expect(f("https://api.github.com.evil.test/x")).rejects.toBeInstanceOf(ConnectorError);
    await expect(f("https://api.github.com/user")).resolves.toBeInstanceOf(Response);
  });

  it("returns bounded bodies and rejects oversized responses", async () => {
    expect(await (await sf()(`${origin}/ok`)).json()).toEqual({ ok: true });
    await expect(sf({ maxBytes: 1000 })(`${origin}/big`)).rejects.toMatchObject({
      category: "provider_rejected",
    });
  });

  it("does not follow redirects", async () => {
    await expect(sf()(`${origin}/redirect`)).rejects.toMatchObject({
      category: "provider_rejected",
    });
  });

  it("times out reads as provider_unavailable and writes as unknown-outcome", async () => {
    await expect(sf({ timeoutMs: 100 })(`${origin}/slow`)).rejects.toMatchObject({
      category: "provider_unavailable",
      maybeDispatched: false,
    });
    await expect(
      sf({ timeoutMs: 100 })(`${origin}/slow`, { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({
      category: "verification_required",
      maybeDispatched: true,
    });
  });

  it("retries safe reads within bounds but never retries a write", async () => {
    hits = {};
    expect(await (await sf()(`${origin}/flaky`)).text()).toBe("recovered");
    hits = {};
    const res = await sf()(`${origin}/flaky`, { method: "POST" });
    expect(res.status).toBe(503);
    expect(hits["/flaky"]).toBe(1);
  });

  it("does not sleep through long rate-limit waits", async () => {
    const res = await sf()(`${origin}/limited`);
    expect(res.status).toBe(429);
  });

  it("reports connection refusal as failed before dispatch, even for writes", async () => {
    // Find a port that is genuinely closed.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const closed = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await new Promise((r) => probe.close(r));
    const f = createSafeFetch({ allowedOrigins: [closed] });
    await expect(f(`${closed}/x`, { method: "POST" })).rejects.toMatchObject({
      category: "failed_before_dispatch",
      maybeDispatched: false,
    });
  });
});

describe("status and rate-limit parsing", () => {
  it("categorises statuses, treating 5xx on writes as ambiguous", () => {
    expect(categorizeStatus(401, true).category).toBe("auth_expired");
    expect(categorizeStatus(403, true).category).toBe("scope_missing");
    expect(categorizeStatus(404, false).category).toBe("destination_inaccessible");
    expect(categorizeStatus(422, true).category).toBe("provider_rejected");
    expect(categorizeStatus(429, false).category).toBe("rate_limited");
    expect(categorizeStatus(502, false)).toEqual({
      category: "provider_unavailable",
      maybeDispatched: false,
    });
    expect(categorizeStatus(502, true)).toEqual({
      category: "verification_required",
      maybeDispatched: true,
    });
  });

  it("parses Retry-After seconds, dates and GitHub reset headers", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "7" }))).toBe(7000);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }), now)).toBe(
      30_000,
    );
    expect(
      retryAfterMs(
        new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 10) }),
        now,
      ),
    ).toBe(10_000);
    expect(
      retryAfterMs(
        new Headers({ "x-ratelimit-remaining": "5", "x-ratelimit-reset": String(now / 1000 + 10) }),
        now,
      ),
    ).toBeNull();
    expect(retryAfterMs(new Headers())).toBeNull();
  });
});
