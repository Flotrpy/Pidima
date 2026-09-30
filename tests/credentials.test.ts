import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents, connectorAccounts, users } from "@/db/schema";
import { ConnectorError } from "@/connectors/errors";
import {
  getAccessToken,
  reportAuthFailure,
  revokeConnector,
  type Refresher,
} from "@/server/credentials";
import { loadCredentials, storeCredentials } from "@/server/vault";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function account(expiresInMs: number | null, refresh = "r0") {
  const email = `c${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Creds");
  const [c] = await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId: ws.id,
      provider: "gmail",
      externalAccountId: `${Math.random()}`,
      displayName: "g",
      connectedByUserId: u!.id,
    })
    .returning();
  await storeCredentials(
    c!.id,
    { accessToken: "old", refreshToken: refresh },
    expiresInMs === null ? null : new Date(Date.now() + expiresInMs),
  );
  return c!;
}

const status = async (id: string) =>
  (await getDb().select().from(connectorAccounts).where(eq(connectorAccounts.id, id)))[0]!.status;

describe("credential refresh coordination", () => {
  it("returns a fresh token without calling the refresher", async () => {
    const c = await account(3_600_000);
    let calls = 0;
    const r: Refresher = async () => (
      calls++,
      { credentials: { accessToken: "new" }, expiresAt: null }
    );
    expect(await getAccessToken(c.id, r)).toBe("old");
    expect(calls).toBe(0);
  });

  it("treats tokens without an expiry as long-lived", async () => {
    const c = await account(null, "");
    expect(await getAccessToken(c.id)).toBe("old");
  });

  it("refreshes exactly once under concurrent demand and keeps a rotated refresh token", async () => {
    const c = await account(-1000);
    let calls = 0;
    const r: Refresher = async () => {
      calls++;
      await new Promise((res) => setTimeout(res, 100));
      return {
        credentials: { accessToken: "fresh", refreshToken: "r1" },
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    };
    const tokens = await Promise.all(Array.from({ length: 10 }, () => getAccessToken(c.id, r)));
    expect(new Set(tokens)).toEqual(new Set(["fresh"]));
    expect(calls).toBe(1);
    expect((await loadCredentials(c.id))?.credentials.refreshToken).toBe("r1");
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const c = await account(-1000, "keepme");
    await getAccessToken(c.id, async () => ({
      credentials: { accessToken: "n" },
      expiresAt: new Date(Date.now() + 3_600_000),
    }));
    expect((await loadCredentials(c.id))?.credentials.refreshToken).toBe("keepme");
  });

  it("marks the connector needs_reauth when the provider rejects the refresh token", async () => {
    const c = await account(-1000);
    await expect(
      getAccessToken(c.id, async () => {
        throw new ConnectorError("auth_expired", "invalid_grant");
      }),
    ).rejects.toMatchObject({ category: "auth_expired" });
    expect(await status(c.id)).toBe("needs_reauth");
    await expect(getAccessToken(c.id)).rejects.toMatchObject({ category: "auth_expired" });
    const events = await getDb().select().from(auditEvents).where(eq(auditEvents.subjectId, c.id));
    expect(events.map((e) => e.action)).toContain("connector.needs_reauth");
  });

  it("does not change connector state on transient refresh failures", async () => {
    const c = await account(-1000);
    await expect(
      getAccessToken(c.id, async () => {
        throw new Error("socket hang up");
      }),
    ).rejects.toMatchObject({ category: "provider_unavailable" });
    expect(await status(c.id)).toBe("active");
  });

  it("flags an expired token that cannot be refreshed", async () => {
    const c = await account(-1000, "");
    await expect(getAccessToken(c.id)).rejects.toMatchObject({ category: "auth_expired" });
    expect(await status(c.id)).toBe("needs_reauth");
  });

  it("revocation deletes credentials and blocks further use", async () => {
    const c = await account(null);
    await revokeConnector(c.id);
    expect(await status(c.id)).toBe("revoked");
    expect(await loadCredentials(c.id)).toBeNull();
    await expect(getAccessToken(c.id)).rejects.toMatchObject({ category: "auth_expired" });
    await reportAuthFailure(c.id);
    expect(await status(c.id)).toBe("revoked");
  });
});
