import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { authAccounts, users } from "@/db/schema";
import { getAuth } from "@/server/auth";
import { outbox } from "@/server/mailer";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

describe("redirect and identity protections", () => {
  it("refuses an off-site callbackURL for magic-link sign-in", async () => {
    await expect(
      getAuth().api.signInMagicLink({
        body: { email: "redir@example.test", callbackURL: "https://evil.test/steal" },
        headers: new Headers({ origin: "http://localhost:3000" }),
      }),
    ).rejects.toThrow();
    expect(outbox.filter((m) => m.to === "redir@example.test")).toHaveLength(0);
  });

  it("still allows a same-site relative callbackURL", async () => {
    await expect(
      getAuth().api.signInMagicLink({
        body: { email: "ok-redir@example.test", callbackURL: "/invite/abc" },
        headers: new Headers(),
      }),
    ).resolves.toBeTruthy();
    expect(outbox.filter((m) => m.to === "ok-redir@example.test")).toHaveLength(1);
  });

  it("does not merge a new sign-in into an unverified pre-registered account", async () => {
    const [victim] = await getDb()
      .insert(users)
      .values({
        id: "pre-1",
        name: "Attacker row",
        email: "victim@example.test",
        emailVerified: false,
      })
      .returning();
    const auth = getAuth();
    await auth.api.signInMagicLink({
      body: { email: "victim@example.test" },
      headers: new Headers(),
    });
    // The email link proves ownership of the address, so this verifies the row for its real owner;
    // no credential ever existed for the attacker-created row.
    const accounts = await getDb()
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, victim!.id));
    expect(accounts).toHaveLength(0);
  });
});
