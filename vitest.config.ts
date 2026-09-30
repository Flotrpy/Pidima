import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      APP_URL: "http://localhost:3000",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@localhost:5432/action_inbox_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
      CREDENTIAL_ENCRYPTION_KEY_V1: Buffer.alloc(32, 1).toString("base64"),
      CRON_SECRET: "cron-secret-cron-secret-cron-secret-0001",
      CONNECTOR_GITHUB_CLIENT_ID: "gh-client-id",
      CONNECTOR_GITHUB_CLIENT_SECRET: "gh-client-secret",
      SMTP_URL: "smtp://unused.test",
      SMTP_FROM: "test@example.test",
    },
    alias: { "server-only": path.resolve(__dirname, "tests/server-only-stub.ts") },
    fileParallelism: false,
    setupFiles: ["tests/setup.ts"],
  },
});
