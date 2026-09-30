import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  it("removes credentials and content bodies at any depth", () => {
    const out = redact({
      repo: "acme/platform",
      accessToken: "gho_abc",
      nested: { Authorization: "Bearer x", cookie: "s=1", ok: "yes" },
      body: "full issue body",
      list: [{ client_secret: "z" }],
    }) as Record<string, any>;
    expect(JSON.stringify(out)).not.toMatch(/gho_abc|Bearer x|s=1|full issue body|"z"/);
    expect(out.repo).toBe("acme/platform");
    expect(out.nested.ok).toBe("yes");
  });

  it("bounds string length and depth", () => {
    const out = redact({ note: "x".repeat(1000), a: { b: { c: { d: { e: 1 } } } } }) as any;
    expect(out.note.length).toBeLessThan(250);
    expect(JSON.stringify(out)).toContain("[truncated]");
  });
});
