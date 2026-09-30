import { describe, expect, it } from "vitest";
import { ERROR_CATEGORIES, ERROR_GUIDANCE } from "./errors";
import { allCapabilities, getCapability, getRuntime, providerOf } from "./registry";
import { emailMessageArgs } from "./capabilities/email-message";
import { githubIssueArgs } from "./capabilities/github-issue";
import { slackMessageArgs } from "./capabilities/slack-message";

describe("registry", () => {
  it("exposes exactly the three Phase 1 write capabilities", () => {
    expect(
      allCapabilities()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["email.propose_message", "github.propose_issue", "slack.propose_message"]);
    expect(providerOf("email.propose_message")).toBe("gmail");
  });

  it("does not resolve unknown or prototype-polluting capability names", () => {
    expect(getCapability("shell.exec")).toBeNull();
    expect(getCapability("__proto__")).toBeNull();
    expect(getCapability("constructor")).toBeNull();
  });

  it("fails closed when a provider runtime is not registered", () => {
    expect(() => getRuntime("slack")).toThrow(/No runtime/);
  });

  it("has recovery guidance for every error category", () => {
    for (const c of ERROR_CATEGORIES) expect(ERROR_GUIDANCE[c].recovery.length).toBeGreaterThan(10);
  });
});

describe("github issue arguments", () => {
  it("normalises to a canonical form", () => {
    const a = githubIssueArgs.parse({
      owner: " Acme ",
      repo: "Platform",
      title: "  Handle   retries ",
      body: "a\r\nb",
      labels: ["bug", "bug", "api"],
    });
    expect(a).toEqual({
      owner: "acme",
      repo: "platform",
      title: "Handle retries",
      body: "a\nb",
      labels: ["api", "bug"],
    });
  });

  it("rejects malformed targets and oversize content", () => {
    expect(() => githubIssueArgs.parse({ owner: "a/b", repo: "x", title: "t" })).toThrow();
    expect(() => githubIssueArgs.parse({ owner: "a", repo: "..", title: "t" })).toThrow();
    expect(() => githubIssueArgs.parse({ owner: "a", repo: "x", title: "" })).toThrow();
    expect(() =>
      githubIssueArgs.parse({ owner: "a", repo: "x", title: "t", body: "x".repeat(60_001) }),
    ).toThrow();
  });
});

describe("slack message arguments", () => {
  it("requires a channel ID and bounded text", () => {
    expect(slackMessageArgs.parse({ channel: "C0123456789", text: "hi" }).channel).toBe(
      "C0123456789",
    );
    expect(() => slackMessageArgs.parse({ channel: "#general", text: "hi" })).toThrow();
    expect(() => slackMessageArgs.parse({ channel: "C0123456789", text: "" })).toThrow();
    expect(() =>
      slackMessageArgs.parse({ channel: "C0123456789", text: "x".repeat(4001) }),
    ).toThrow();
    expect(() =>
      slackMessageArgs.parse({ channel: "C0123456789", text: "hi", threadTs: "abc" }),
    ).toThrow();
  });
});

describe("email message arguments", () => {
  const ok = {
    from: "me@Example.com",
    to: ["A@Example.com", "a@example.com"],
    subject: "Hi",
    textBody: "Hello",
  };

  it("lowercases domains and de-duplicates recipients", () => {
    const a = emailMessageArgs.parse(ok);
    expect(a.from).toBe("me@example.com");
    expect(a.to).toEqual(["A@example.com", "a@example.com"]);
  });

  it("rejects header injection, missing recipients and missing bodies", () => {
    expect(() => emailMessageArgs.parse({ ...ok, to: ["a@b.com\r\nBcc: evil@x.com"] })).toThrow();
    expect(() => emailMessageArgs.parse({ ...ok, to: ["Name <a@b.com>"] })).toThrow();
    expect(() => emailMessageArgs.parse({ ...ok, to: [] })).toThrow();
    expect(() => emailMessageArgs.parse({ ...ok, textBody: undefined })).toThrow();
    const subject = emailMessageArgs.parse({ ...ok, subject: "Line\r\nBcc: x" }).subject;
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("bounds recipient counts", () => {
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
    expect(() => emailMessageArgs.parse({ ...ok, to: many })).toThrow();
  });
});
