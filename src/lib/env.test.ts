import { describe, expect, it } from "vitest";
import { getEnv } from "./env";

describe("getEnv", () => {
  it("accepts a valid configuration", () => {
    const env = getEnv({
      NODE_ENV: "test",
      APP_URL: "https://x.test",
      DATABASE_URL: "postgres://a",
    });
    expect(env.APP_URL).toBe("https://x.test");
  });

  it("names invalid variables without echoing values", () => {
    expect(() => getEnv({ APP_URL: "nope-secret", DATABASE_URL: "" })).toThrow(
      /APP_URL, DATABASE_URL/,
    );
    expect(() => getEnv({ APP_URL: "nope-secret", DATABASE_URL: "" })).not.toThrow(/nope-secret/);
  });
});
