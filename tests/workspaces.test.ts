import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { capabilityPolicies, users } from "@/db/schema";
import { outbox } from "@/server/mailer";
import {
  WorkspaceError,
  acceptInvitation,
  changeMemberRole,
  createWorkspace,
  getMembership,
  inviteMember,
  listMemberships,
  removeMember,
  revokeInvitation,
} from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function userId(email: string) {
  await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  return u!.id;
}

describe("workspaces and membership", () => {
  it("creates a personal workspace on first sign-in with deny-by-default policies", async () => {
    const id = await userId("first@example.test");
    const [m] = await listMemberships(id);
    expect(m?.workspace.isPersonal).toBe(true);
    expect(m?.role).toBe("owner");
    const policies = await getDb()
      .select()
      .from(capabilityPolicies)
      .where(eq(capabilityPolicies.workspaceId, m!.workspace.id));
    expect(policies).toHaveLength(3);
    expect(policies.every((p) => !p.enabled)).toBe(true);
  });

  it("invites, accepts only with the invited verified email, and consumes the token", async () => {
    const owner = await userId("own@example.test");
    const ws = await createWorkspace(owner, "Acme");
    const { url } = await inviteMember(owner, ws.id, "Invitee@Example.test", "approver");
    expect(outbox.at(-1)!.text).toContain(url);
    const token = url.split("/invite/")[1]!;

    const stranger = await userId("stranger@example.test");
    await expect(acceptInvitation(stranger, token)).rejects.toMatchObject({ code: "forbidden" });

    const invitee = await userId("invitee@example.test");
    await acceptInvitation(invitee, token);
    expect((await getMembership(invitee, ws.id))?.role).toBe("approver");
    await expect(acceptInvitation(invitee, token)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects revoked and expired invitations", async () => {
    const owner = await userId("own2@example.test");
    const ws = await createWorkspace(owner, "Beta");
    const a = await inviteMember(owner, ws.id, "r@example.test", "member");
    await revokeInvitation(owner, ws.id, a.invitationId);
    const r = await userId("r@example.test");
    await expect(acceptInvitation(r, a.url.split("/invite/")[1]!)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("only owners manage members, and the last owner cannot be removed or demoted", async () => {
    const owner = await userId("own3@example.test");
    const other = await userId("mem3@example.test");
    const ws = await createWorkspace(owner, "Gamma");
    const { url } = await inviteMember(owner, ws.id, "mem3@example.test", "member");
    await acceptInvitation(other, url.split("/invite/")[1]!);

    await expect(inviteMember(other, ws.id, "x@example.test", "viewer")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(changeMemberRole(other, ws.id, owner, "viewer")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(changeMemberRole(owner, ws.id, owner, "member")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(removeMember(owner, ws.id, owner)).rejects.toMatchObject({ code: "conflict" });

    await changeMemberRole(owner, ws.id, other, "owner");
    await removeMember(owner, ws.id, owner);
    expect(await getMembership(owner, ws.id)).toBeNull();
  });

  it("hides workspaces from non-members", async () => {
    const owner = await userId("own4@example.test");
    const outsider = await userId("out4@example.test");
    const ws = await createWorkspace(owner, "Delta");
    expect(await getMembership(outsider, ws.id)).toBeNull();
    await expect(inviteMember(outsider, ws.id, "z@example.test", "member")).rejects.toBeInstanceOf(
      WorkspaceError,
    );
  });
});
