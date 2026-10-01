import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvents, mcpClients, mcpGrants, users, workspaces } from "@/db/schema";
import {
  WorkspaceError,
  acceptInvitation,
  closeWorkspace,
  createWorkspace,
  getMembership,
  inviteMember,
  renameWorkspace,
} from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const uid = async (email: string) => {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
};

describe("workspace settings", () => {
  it("lets owners rename, rejects bad names and non-owners, and audits", async () => {
    const owner = await uid("s1@example.test");
    const other = await uid("s2@example.test");
    const ws = await createWorkspace(owner, "Acme");
    const { url } = await inviteMember(owner, ws.id, "s2@example.test", "member");
    await acceptInvitation(other, url.split("/invite/")[1]!);
    await renameWorkspace(owner, ws.id, "  Acme   Corp ");
    expect((await getDb().select().from(workspaces).where(eq(workspaces.id, ws.id)))[0]!.name).toBe(
      "Acme Corp",
    );
    await expect(renameWorkspace(owner, ws.id, "x")).rejects.toBeInstanceOf(WorkspaceError);
    await expect(renameWorkspace(other, ws.id, "Hijack")).rejects.toThrow();
    const ev = await getDb().select().from(auditEvents).where(eq(auditEvents.workspaceId, ws.id));
    expect(ev.some((e) => e.action === "workspace.renamed")).toBe(true);
  });

  it("closes only for the owner with the exact name, revokes grants, hides the workspace", async () => {
    const owner = await uid("s3@example.test");
    const member = await uid("s4@example.test");
    const ws = await createWorkspace(owner, "Gone Soon");
    const { url } = await inviteMember(owner, ws.id, "s4@example.test", "member");
    await acceptInvitation(member, url.split("/invite/")[1]!);
    const [c] = await getDb()
      .insert(mcpClients)
      .values({ clientId: "c-" + ws.id, name: "t", redirectUris: ["https://x.test/cb"] } as never)
      .returning();
    const [g] = await getDb()
      .insert(mcpGrants)
      .values({
        mcpClientId: c!.id,
        userId: owner,
        workspaceId: ws.id,
        scopes: ["proposals:create"],
      } as never)
      .returning();

    await expect(closeWorkspace(member, ws.id, "Gone Soon")).rejects.toThrow();
    await expect(closeWorkspace(owner, ws.id, "wrong")).rejects.toBeInstanceOf(WorkspaceError);
    await closeWorkspace(owner, ws.id, "Gone Soon");

    expect(await getMembership(owner, ws.id)).toBeNull();
    expect(
      (await getDb().select().from(mcpGrants).where(eq(mcpGrants.id, g!.id)))[0]!.revokedAt,
    ).not.toBeNull();
    await expect(closeWorkspace(owner, ws.id, "Gone Soon")).rejects.toThrow();
  });
});
