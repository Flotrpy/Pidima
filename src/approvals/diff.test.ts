import { describe, expect, it } from "vitest";
import { diffArgs, diffLines } from "./diff";

describe("diffLines", () => {
  it("marks additions, deletions and unchanged lines in order", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
  });

  it("reports identical text as all-same and empty-to-text as all-add", () => {
    expect(diffLines("x\ny", "x\ny").every((l) => l.type === "same")).toBe(true);
    expect(diffLines("", "hi")).toEqual([
      { type: "del", text: "" },
      { type: "add", text: "hi" },
    ]);
  });

  it("bounds work on very large inputs", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n");
    const started = Date.now();
    const d = diffLines(big, big + "\nextra");
    expect(Date.now() - started).toBeLessThan(500);
    expect(d.length).toBeGreaterThan(2000);
  });
});

describe("diffArgs", () => {
  const before = {
    owner: "acme",
    repo: "platform",
    title: "Handle retries",
    body: "one\ntwo",
    labels: ["bug"],
  };

  it("returns nothing when nothing changed", () => {
    expect(diffArgs(before, { ...before })).toEqual([]);
  });

  it("classifies scalar, multi-line and list changes", () => {
    const after = {
      ...before,
      title: "Handle webhook retries",
      body: "one\nthree",
      labels: ["bug", "api"],
    };
    const d = diffArgs(before, after);
    expect(d.map((x) => [x.key, x.kind])).toEqual([
      ["body", "text"],
      ["labels", "list"],
      ["title", "scalar"],
    ]);
    const list = d.find((x) => x.key === "labels");
    expect(list).toMatchObject({ added: ["api"], removed: [] });
    const body = d.find((x) => x.key === "body");
    expect(body?.kind === "text" && body.lines.filter((l) => l.type !== "same")).toEqual([
      { type: "del", text: "two" },
      { type: "add", text: "three" },
    ]);
  });

  it("detects a changed destination", () => {
    const d = diffArgs(before, { ...before, repo: "secrets" });
    expect(d).toEqual([{ key: "repo", kind: "scalar", before: "platform", after: "secrets" }]);
  });

  it("treats a newly added or removed optional field as a change", () => {
    expect(diffArgs({ a: 1 }, { a: 1, threadTs: "1.2" }).map((x) => x.key)).toEqual(["threadTs"]);
    expect(diffArgs({ a: 1, threadTs: "1.2" }, { a: 1 }).map((x) => x.key)).toEqual(["threadTs"]);
  });
});
