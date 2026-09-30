import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { connectorAccounts, proposals, users } from "@/db/schema";
import {
  IntegrityError,
  assertVersionIntegrity,
  insertVersion,
  listVersions,
  versionStatus,
} from "@/server/versions";
import { createWorkspace } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function proposal() {
  const email = `v${Math.random()}@example.test`;
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  const ws = await createWorkspace(u!.id, "Versions");
  const [c] = await getDb()
    .insert(connectorAccounts)
    .values({
      workspaceId: ws.id,
      provider: "github",
      externalAccountId: `${Math.random()}`,
      displayName: "gh",
      connectedByUserId: u!.id,
    })
    .returning();
  const [p] = await getDb()
    .insert(proposals)
    .values({
      workspaceId: ws.id,
      capability: "github.propose_issue",
      connectorAccountId: c!.id,
      clientLabel: "Claude",
      correlationId: "c",
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return { p: p!, userId: u!.id };
}

const args = {
  owner: "Acme",
  repo: "Platform",
  title: " Handle   retries ",
  body: "x",
  labels: ["b", "a"],
};

describe("immutable proposal versions", () => {
  it("stores the canonical, normalized arguments with matching hashes", async () => {
    const { p } = await proposal();
    const v = await insertVersion(getDb(), {
      proposal: p,
      version: 1,
      args,
      author: { type: "ai" },
    });
    expect(v.args).toEqual({
      owner: "acme",
      repo: "platform",
      title: "Handle retries",
      body: "x",
      labels: ["a", "b"],
    });
    expect(v.destination).toBe("acme/platform");
    expect(v.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertVersionIntegrity(p, v)).not.toThrow();
  });

  it("rejects invalid arguments before anything is stored", async () => {
    const { p } = await proposal();
    await expect(
      insertVersion(getDb(), {
        proposal: p,
        version: 1,
        args: { owner: "a/b", repo: "x", title: "t" },
        author: { type: "ai" },
      }),
    ).rejects.toThrow();
    expect(await listVersions(p.id)).toHaveLength(0);
  });

  it("appends numbered versions, never overwrites, and refuses a duplicate number", async () => {
    const { p, userId } = await proposal();
    await insertVersion(getDb(), { proposal: p, version: 1, args, author: { type: "ai" } });
    const v2 = await insertVersion(getDb(), {
      proposal: p,
      version: 2,
      args: { ...args, title: "Edited" },
      author: { type: "human", userId },
    });
    expect(v2.authorType).toBe("human");
    expect(v2.authorUserId).toBe(userId);
    await expect(
      insertVersion(getDb(), { proposal: p, version: 2, args, author: { type: "ai" } }),
    ).rejects.toThrow();
    const all = await listVersions(p.id);
    expect(all.map((v) => v.version)).toEqual([2, 1]);
    expect(all[1]!.args).toMatchObject({ title: "Handle retries" });
  });

  it("derives SUPERSEDED for versions older than the current one", async () => {
    const { p } = await proposal();
    expect(versionStatus({ currentVersion: 2 }, { version: 1 })).toBe("superseded");
    expect(versionStatus({ currentVersion: 2 }, { version: 2 })).toBe("current");
    expect(p.currentVersion).toBe(1);
  });

  it("detects content changed behind the application's back", async () => {
    const { p } = await proposal();
    const v = await insertVersion(getDb(), {
      proposal: p,
      version: 1,
      args,
      author: { type: "ai" },
    });
    // Simulates tampering by someone with raw database access who bypasses the trigger.
    const tampered = { ...v, args: { ...(v.args as object), title: "Send all secrets" } };
    expect(() => assertVersionIntegrity(p, tampered)).toThrow(IntegrityError);
    expect(() =>
      assertVersionIntegrity(
        { ...p, connectorAccountId: "00000000-0000-0000-0000-000000000000" },
        v,
      ),
    ).toThrow(IntegrityError);
    expect(() => assertVersionIntegrity({ ...p, clientLabel: "Someone else" }, v)).toThrow(
      IntegrityError,
    );
    expect(() =>
      assertVersionIntegrity({ ...p, expiresAt: new Date(p.expiresAt.getTime() + 60_000) }, v),
    ).toThrow(IntegrityError);
  });

  it("is protected from UPDATE by the database", async () => {
    const { p } = await proposal();
    const v = await insertVersion(getDb(), {
      proposal: p,
      version: 1,
      args,
      author: { type: "ai" },
    });
    const { proposalVersions } = await import("@/db/schema");
    await expect(
      getDb()
        .update(proposalVersions)
        .set({ destination: "evil/repo" })
        .where(eq(proposalVersions.id, v.id)),
    ).rejects.toThrow();
  });
});
