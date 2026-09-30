import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { getAuth } from "@/server/auth";
import { CsrfError, assertSameOrigin } from "@/server/csrf";
import { revokeUserSessions } from "@/server/session-admin";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const req = (headers: Record<string, string>, method = "POST") =>
  new Request("http://localhost:3000/x", { method, headers });

describe("session lifecycle", () => {
  it("issues a fresh token on every sign-in", async () => {
    const a = await signInAs("rot@example.test");
    const b = await signInAs("rot@example.test");
    expect(a.get("cookie")).not.toEqual(b.get("cookie"));
  });

  it("sign-out invalidates the server-side session", async () => {
    const h = await signInAs("out@example.test");
    const auth = getAuth();
    expect(await auth.api.getSession({ headers: h })).not.toBeNull();
    await auth.api.signOut({ headers: h });
    expect(await auth.api.getSession({ headers: h })).toBeNull();
  });

  it("rejects expired sessions immediately", async () => {
    const h = await signInAs("exp@example.test");
    const [u] = await getDb().select().from(users).where(eq(users.email, "exp@example.test"));
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, u!.id));
    expect(await getAuth().api.getSession({ headers: h })).toBeNull();
  });

  it("revokeUserSessions ends all sessions for a user", async () => {
    const h1 = await signInAs("rev@example.test");
    const h2 = await signInAs("rev@example.test");
    const [u] = await getDb().select().from(users).where(eq(users.email, "rev@example.test"));
    expect(await revokeUserSessions(u!.id)).toBe(2);
    expect(await getAuth().api.getSession({ headers: h1 })).toBeNull();
    expect(await getAuth().api.getSession({ headers: h2 })).toBeNull();
  });
});

describe("csrf origin check", () => {
  it("allows same-origin and safe methods", () => {
    expect(() => assertSameOrigin(req({ origin: "http://localhost:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameOrigin(req({}, "GET"))).not.toThrow();
  });

  it("rejects cross-site, unknown and header-less mutations", () => {
    expect(() => assertSameOrigin(req({ origin: "https://evil.test" }))).toThrow(CsrfError);
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toThrow(CsrfError);
    expect(() => assertSameOrigin(req({}))).toThrow(CsrfError);
  });
});
