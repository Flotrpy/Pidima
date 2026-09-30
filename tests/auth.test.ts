import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { getAuth } from "@/server/auth";
import { outbox } from "@/server/mailer";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);
afterAll(async () => {
  (globalThis as unknown as { __db?: { pool: { end(): Promise<void> } } }).__db?.pool.end();
});

describe("real authentication", () => {
  it("creates a persistent user and session through a verified magic link", async () => {
    const auth = getAuth();
    await auth.api.signInMagicLink({
      body: { email: "maya@example.test", name: "Maya" },
      headers: new Headers(),
    });
    const link = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    const token = new URL(link).searchParams.get("token")!;

    const res = await auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
      asResponse: true,
    });
    const cookie = res.headers.getSetCookie().join("; ");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const [u] = await getDb().select().from(users).where(eq(users.email, "maya@example.test"));
    expect(u?.emailVerified).toBe(true);
    const rows = await getDb().select().from(sessions).where(eq(sessions.userId, u!.id));
    expect(rows).toHaveLength(1);
  });

  it("does not accept a magic link twice", async () => {
    const auth = getAuth();
    await auth.api.signInMagicLink({
      body: { email: "once@example.test" },
      headers: new Headers(),
    });
    const token = new URL(outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get(
      "token",
    )!;
    const first = await auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
      asResponse: true,
    });
    expect(first.status).toBeLessThan(400);
    const second = await auth.api
      .magicLinkVerify({ query: { token }, headers: new Headers(), asResponse: true })
      .catch((e) => e);
    const status = second.status ?? second.statusCode;
    const location = second.headers?.get?.("location") ?? "";
    expect(status >= 400 || /error/i.test(location)).toBe(true);
  });
});
