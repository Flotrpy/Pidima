import { describe, expect, it } from "vitest";
import { argsHash, bindingHash, canonicalize, type BindingInput } from "./hashing";

const base: BindingInput = {
  workspaceId: "w1",
  capability: "github.propose_issue",
  connectorAccountId: "c1",
  destination: "acme/platform",
  args: { owner: "acme", repo: "platform", title: "T", body: "B", labels: ["a"] },
  client: { grantId: "g1", label: "Claude" },
  expiresAt: new Date("2026-01-01T00:00:00Z"),
};

describe("canonicalize", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: undefined } })).toBe(
      canonicalize({ a: { c: undefined, d: 2 }, b: 1 }),
    );
    expect(canonicalize({ a: undefined })).toBe("{}");
  });

  it("keeps array order significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("normalizes unicode so visually identical text hashes identically", () => {
    expect(argsHash({ t: "é" })).toBe(argsHash({ t: "é" }));
  });

  it("rejects values with no canonical form", () => {
    expect(() => canonicalize({ n: NaN })).toThrow();
    expect(() => canonicalize({ n: Infinity })).toThrow();
  });

  it("separates structure from content (no delimiter collisions)", () => {
    expect(canonicalize({ a: "b,c" })).not.toBe(canonicalize({ a: "b", c: "" }));
    expect(canonicalize(["a", "b"])).not.toBe(canonicalize(["a,b"]));
  });
});

describe("bindingHash", () => {
  const h = bindingHash(base);

  it("is stable for identical input", () => {
    expect(bindingHash({ ...base, args: { ...base.args } })).toBe(h);
  });

  it.each([
    ["workspace", { workspaceId: "w2" }],
    ["capability", { capability: "slack.propose_message" }],
    ["connector account", { connectorAccountId: "c2" }],
    ["destination", { destination: "acme/other" }],
    ["arguments", { args: { ...base.args, title: "T2" } }],
    ["proposing client", { client: { grantId: "g2", label: "Claude" } }],
    ["client label", { client: { grantId: "g1", label: "Other" } }],
    ["expiration", { expiresAt: new Date("2026-01-01T00:00:01Z") }],
  ])("changes when the %s changes", (_n, patch) => {
    expect(bindingHash({ ...base, ...patch })).not.toBe(h);
  });
});
