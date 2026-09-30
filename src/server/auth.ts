import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { configuredAuthMethods, getEnv } from "@/lib/env";
import { sendMail } from "./mailer";

function build() {
  const env = getEnv();
  const methods = configuredAuthMethods(env);

  return betterAuth({
    appName: "AI Action Inbox",
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.authAccounts,
        verification: schema.verifications,
      },
    }),
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // No signed cookie cache: a revoked or deleted session must stop working immediately.
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === "production",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    socialProviders: {
      ...(methods.includes("google") && {
        google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! },
      }),
      ...(methods.includes("github") && {
        github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! },
      }),
    },
    plugins: [
      ...(methods.includes("email")
        ? [
            magicLink({
              expiresIn: 60 * 10,
              sendMagicLink: async ({ email, url }) => {
                await sendMail({
                  to: email,
                  subject: "Your AI Action Inbox sign-in link",
                  text: `Use this link to sign in. It expires in 10 minutes and works once.\n\n${url}\n\nIf you did not request it, ignore this email.`,
                });
              },
            }),
          ]
        : []),
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof build>;
const g = globalThis as unknown as { __auth?: Auth };

export function getAuth(): Auth {
  return (g.__auth ??= build());
}
