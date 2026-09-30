import { describe, expect, it } from "vitest";
import { configuredAuthMethods, getEnv } from "./env";

const base = {
  NODE_ENV: "test",
  APP_URL: "https://x.test",
  DATABASE_URL: "postgres://a",
  BETTER_AUTH_SECRET: "s".repeat(32),
};

describe("getEnv", () => {
  it("accepts a valid configuration", () => {
    expect(getEnv(base).APP_URL).toBe("https://x.test");
  });

  it("names invalid variables without echoing values", () => {
    const bad = { ...base, APP_URL: "nope-secret", DATABASE_URL: "", BETTER_AUTH_SECRET: "short" };
    expect(() => getEnv(bad)).toThrow(/APP_URL, DATABASE_URL, BETTER_AUTH_SECRET/);
    expect(() => getEnv(bad)).not.toThrow(/nope-secret|short/);
  });

  it("hides sign-in methods that are not fully configured", () => {
    expect(configuredAuthMethods(getEnv(base))).toEqual([]);
    expect(configuredAuthMethods(getEnv({ ...base, GOOGLE_CLIENT_ID: "id" }))).toEqual([]);
    const full = getEnv({
      ...base,
      GOOGLE_CLIENT_ID: "a",
      GOOGLE_CLIENT_SECRET: "b",
      GITHUB_CLIENT_ID: "c",
      GITHUB_CLIENT_SECRET: "d",
      SMTP_URL: "smtp://localhost",
      SMTP_FROM: "no-reply@x.test",
    });
    expect(configuredAuthMethods(full)).toEqual(["google", "github", "email"]);
  });
});
