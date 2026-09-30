import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getAuth } from "@/server/auth";
import { loadMembership, requirePermission } from "@/server/authz";
import {
  acceptInvitation,
  changeMemberRole,
  createWorkspace,
  inviteMember,
  removeMember,
  setApprovalCapabilities,
} from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

async function user(email: string) {
  const h = await signInAs(email);
  const [u] = await getDb().select().from(users).where(eq(users.email, email));
  return { id: u!.id, h };
}

async function join(
  ownerId: string,
  wsId: string,
  email: string,
  role: "approver" | "member" | "viewer",
) {
  const u = await user(email);
  const { url } = await inviteMember(ownerId, wsId, email, role);
  await acceptInvitation(u.id, url.split("/invite/")[1]!);
  return u;
}

describe("server-enforced roles", () => {
  it("enforces each role against the permission matrix from the database", async () => {
    const owner = await user("o@example.test");
    const ws = await createWorkspace(owner.id, "Roles");
    const approver = await join(owner.id, ws.id, "a@example.test", "approver");
    const member = await join(owner.id, ws.id, "m@example.test", "member");
    const viewer = await join(owner.id, ws.id, "v@example.test", "viewer");

    await expect(requirePermission(owner.id, ws.id, "policies.manage")).resolves.toBeTruthy();
    await expect(requirePermission(approver.id, ws.id, "proposals.decide")).resolves.toBeTruthy();
    await expect(requirePermission(approver.id, ws.id, "connectors.manage")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(requirePermission(member.id, ws.id, "proposals.decide")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(requirePermission(viewer.id, ws.id, "proposals.view")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(requirePermission(viewer.id, ws.id, "receipts.view")).resolves.toBeTruthy();
  });

  it("treats non-members as not found rather than forbidden", async () => {
    const owner = await user("o2@example.test");
    const stranger = await user("s2@example.test");
    const ws = await createWorkspace(owner.id, "Private");
    await expect(requirePermission(stranger.id, ws.id, "receipts.view")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("applies role changes immediately and ends the affected user's sessions", async () => {
    const owner = await user("o3@example.test");
    const ws = await createWorkspace(owner.id, "Change");
    const appr = await join(owner.id, ws.id, "a3@example.test", "approver");
    expect(await getAuth().api.getSession({ headers: appr.h })).not.toBeNull();

    await changeMemberRole(owner.id, ws.id, appr.id, "viewer");
    await expect(requirePermission(appr.id, ws.id, "proposals.decide")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await getAuth().api.getSession({ headers: appr.h })).toBeNull();
  });

  it("removed members lose access", async () => {
    const owner = await user("o4@example.test");
    const ws = await createWorkspace(owner.id, "Remove");
    const m = await join(owner.id, ws.id, "m4@example.test", "member");
    await removeMember(owner.id, ws.id, m.id);
    expect(await loadMembership(m.id, ws.id)).toBeNull();
  });

  it("stores a restricted approval scope", async () => {
    const owner = await user("o5@example.test");
    const ws = await createWorkspace(owner.id, "Scope");
    const appr = await join(owner.id, ws.id, "a5@example.test", "approver");
    await setApprovalCapabilities(owner.id, ws.id, appr.id, ["github.propose_issue"]);
    expect((await loadMembership(appr.id, ws.id))?.approvalCapabilities).toEqual([
      "github.propose_issue",
    ]);
    await expect(setApprovalCapabilities(appr.id, ws.id, appr.id, null)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
