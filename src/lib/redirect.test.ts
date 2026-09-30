import { describe, expect, it } from "vitest";
import { redirectParamsAreSafe, safeReturnTo } from "./redirect";

describe("safeReturnTo", () => {
  it("keeps same-site relative paths", () => {
    expect(safeReturnTo("/inbox/abc?x=1#y")).toBe("/inbox/abc?x=1#y");
    expect(safeReturnTo("/invite/tok-en_1")).toBe("/invite/tok-en_1");
  });

  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "\\\\evil.test",
    "javascript:alert(1)",
    "/%0d%0aSet-Cookie:x",
    "/ok\r\nLocation: x",
    "inbox",
    "",
    "/sign-in?returnTo=/team",
    "/api/auth/sign-out",
    "/" + "a".repeat(600),
  ])("falls back for %j", (bad) => {
    expect(safeReturnTo(bad)).toBe("/inbox");
  });

  it("returns null-ish input as the fallback", () => {
    expect(safeReturnTo(null)).toBe("/inbox");
    expect(safeReturnTo(undefined, "/team")).toBe("/team");
  });
});

describe("redirectParamsAreSafe", () => {
  const origin = "https://app.example.test";
  it("accepts relative paths, same-origin URLs and absent params", () => {
    expect(redirectParamsAreSafe(undefined, origin)).toBe(true);
    expect(redirectParamsAreSafe({ callbackURL: "/inbox" }, origin)).toBe(true);
    expect(redirectParamsAreSafe({ callbackURL: "https://app.example.test/team" }, origin)).toBe(
      true,
    );
  });

  it("refuses foreign origins, protocol-relative, scheme and non-string values", () => {
    for (const v of [
      "https://evil.test/x",
      "//evil.test",
      "javascript:alert(1)",
      "http://app.example.test.evil.test",
      5,
      {},
    ]) {
      expect(redirectParamsAreSafe({ callbackURL: v }, origin)).toBe(false);
    }
    expect(redirectParamsAreSafe({ errorCallbackURL: "https://evil.test" }, origin)).toBe(false);
  });
});
