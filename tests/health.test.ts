import { describe, expect, it } from "vitest";
import { GET as live } from "@/app/api/health/route";
import { GET as ready } from "@/app/api/ready/route";

describe("health endpoints", () => {
  it("liveness is ok and uncached", async () => {
    const r = live();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("readiness reports check names only and no secrets", async () => {
    const r = await ready();
    const body = await r.json();
    expect(Object.keys(body.checks)).toEqual(["config", "keys", "database"]);
    expect(body.checks.database).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/postgres:|secret|KEY_V/i);
  });
});
