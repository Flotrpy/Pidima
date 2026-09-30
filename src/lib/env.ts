import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  /** Signs sessions and derives per-purpose keys. At least 32 characters. */
  BETTER_AUTH_SECRET: z.string().min(32),
  // Sign-in providers (separate OAuth apps from the connector apps).
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  // Transactional email for magic links and notifications.
  SMTP_URL: optional,
  SMTP_FROM: optional,
  // Connector OAuth apps (what Claude may propose actions for). Separate from sign-in apps.
  CONNECTOR_GITHUB_CLIENT_ID: optional,
  CONNECTOR_GITHUB_CLIENT_SECRET: optional,
  CONNECTOR_SLACK_CLIENT_ID: optional,
  CONNECTOR_SLACK_CLIENT_SECRET: optional,
  CONNECTOR_GOOGLE_CLIENT_ID: optional,
  CONNECTOR_GOOGLE_CLIENT_SECRET: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validates required configuration once; error messages list names only, never values. */
export function getEnv(source: Record<string, string | undefined> = process.env): Env {
  if (source === process.env && cached) return cached;
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid environment configuration: ${names.join(", ")}`);
  }
  if (source === process.env) cached = result.data;
  return result.data;
}

export type ConnectorProvider = "github" | "slack" | "gmail";

/** Connector providers whose OAuth app is fully configured for this deployment. */
export function configuredConnectors(env: Env): ConnectorProvider[] {
  const out: ConnectorProvider[] = [];
  if (env.CONNECTOR_GITHUB_CLIENT_ID && env.CONNECTOR_GITHUB_CLIENT_SECRET) out.push("github");
  if (env.CONNECTOR_SLACK_CLIENT_ID && env.CONNECTOR_SLACK_CLIENT_SECRET) out.push("slack");
  if (env.CONNECTOR_GOOGLE_CLIENT_ID && env.CONNECTOR_GOOGLE_CLIENT_SECRET) out.push("gmail");
  return out;
}

export type AuthMethod = "google" | "github" | "email";

/** Sign-in methods that are fully configured. Unconfigured methods must not be shown. */
export function configuredAuthMethods(env: Env): AuthMethod[] {
  const methods: AuthMethod[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) methods.push("google");
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) methods.push("github");
  if (env.SMTP_URL && env.SMTP_FROM) methods.push("email");
  return methods;
}
