import { defineConfig } from "@playwright/test";

const PORT = 3223;
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: {
      APP_URL: `http://localhost:${PORT}`,
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/action_inbox",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-secret-e2e-secret-e2e-secret-1234",
      CREDENTIAL_ENCRYPTION_KEY_V1:
        process.env.CREDENTIAL_ENCRYPTION_KEY_V1 ?? Buffer.alloc(32, 7).toString("base64"),
    },
  },
});
