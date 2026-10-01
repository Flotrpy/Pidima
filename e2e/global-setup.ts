import { execFileSync } from "node:child_process";

export default function globalSetup() {
  execFileSync("node", ["--conditions", "react-server", "--import", "tsx", "e2e/seed.ts"], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      SMTP_URL: "smtp://unused.invalid",
      SMTP_FROM: "e2e@example.test",
      APP_URL: "http://localhost:3223",
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/action_inbox",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-secret-e2e-secret-e2e-secret-1234",
      CREDENTIAL_ENCRYPTION_KEY_V1:
        process.env.CREDENTIAL_ENCRYPTION_KEY_V1 ?? Buffer.alloc(32, 7).toString("base64"),
    },
  });
}
