import { describe, expect, it } from "vitest";
import { argsToForm, formToArgs } from "./edit-specs";

describe("edit form mapping", () => {
  it("round-trips list and text fields", () => {
    const args = {
      owner: "acme",
      repo: "platform",
      title: "T",
      body: "a\nb",
      labels: ["bug", "api"],
    };
    const form = argsToForm("github.propose_issue", args);
    expect(form.labels).toBe("bug\napi");
    expect(formToArgs("github.propose_issue", (n) => form[n] ?? null)).toEqual(args);
  });

  it("splits recipients on lines or commas and drops blanks", () => {
    const args = formToArgs(
      "email.propose_message",
      (n) =>
        (
          ({ from: "a@b.co", to: "x@y.co, z@y.co\n\n", subject: "s", textBody: "hi" }) as Record<
            string,
            string
          >
        )[n] ?? null,
    );
    expect(args.to).toEqual(["x@y.co", "z@y.co"]);
    expect(args.cc).toEqual([]);
    expect(args.htmlBody).toBeUndefined();
  });

  it("treats an empty optional thread timestamp as absent", () => {
    expect(
      formToArgs(
        "slack.propose_message",
        (n) =>
          (({ channel: "C0123456789", text: "hi", threadTs: "  " }) as Record<string, string>)[n] ??
          null,
      ).threadTs,
    ).toBeUndefined();
  });
});
