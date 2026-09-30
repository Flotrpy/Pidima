import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpGrants, users } from "@/db/schema";
import { POST as register } from "@/app/api/oauth/register/route";
import { POST as tokenEndpoint } from "@/app/api/oauth/token/route";
import { mcpResourceUrl } from "@/mcp/metadata";
import { pkceChallenge, verifyAccessToken } from "@/server/mcp-oauth";
import {
  AuthorizeFatal,
  AuthorizeRedirectable,
  approveAuthorization,
  connectableWorkspaces,
  denyAuthorization,
  errorRedirect,
  listGrants,
  revokeGrant,
  validateAuthorizeRequest,
} from "@/server/mcp-consent";
import { acceptInvitation, createWorkspace, inviteMember } from "@/server/workspaces";
import { signInAs } from "./auth-helpers";
import { resetTestDatabase } from "./helpers";

beforeAll(resetTestDatabase);

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function user(email: string) {
  await signInAs(email);
  return (await getDb().select().from(users).where(eq(users.email, email)))[0]!.id;
}

async function join(ownerId: string, wsId: string, role: "member" | "viewer" | "approver") {
  const email = `j${Math.random()}@example.test`;
  const id = await user(email);
  const { url } = await inviteMember(ownerId, wsId, email, role);
  await acceptInvitation(id, url.split("/invite/")[1]!);
  return id;
}

async function setup() {
  const owner = await user(`o${Math.random()}@example.test`);
  const ws = await createWorkspace(owner, "Consent");
  const reg = await register(
    new Request("http://localhost:3000/api/oauth/register", {
      method: "POST",
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    }),
  );
  const client = await reg.json();
  const verifier = randomBytes(48).toString("base64url");
  const raw = (over: Record<string, string | undefined> = {}) => ({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    scope: "proposals:create proposals:read",
    state: "xyz",
    ...over,
  });
  return { owner, ws, client, verifier, raw };
}

describe("authorization request validation", () => {
  it("never redirects for an unknown client or unregistered redirect URI", async () => {
    const s = await setup();
    await expect(validateAuthorizeRequest(s.raw({ client_id: "mcp_nope" }))).rejects.toBeInstanceOf(
      AuthorizeFatal,
    );
    await expect(
      validateAuthorizeRequest(s.raw({ redirect_uri: "https://evil.test/cb" })),
    ).rejects.toBeInstanceOf(AuthorizeFatal);
    await expect(
      validateAuthorizeRequest(s.raw({ redirect_uri: undefined })),
    ).rejects.toBeInstanceOf(AuthorizeFatal);
    await expect(
      validateAuthorizeRequest(s.raw({ redirect_uri: REDIRECT + "/" })),
    ).rejects.toBeInstanceOf(AuthorizeFatal);
  });

  it("returns protocol errors to the verified redirect URI, echoing state", async () => {
    const s = await setup();
    for (const [over, err] of [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ scope: "proposals:create admin" }, "invalid_scope"],
      [{ resource: "https://elsewhere.test/mcp" }, "invalid_target"],
    ] as const) {
      const e = await validateAuthorizeRequest(s.raw(over)).catch((x) => x);
      expect(e).toBeInstanceOf(AuthorizeRedirectable);
      const u = new URL(errorRedirect(e));
      expect(u.origin + u.pathname).toBe(REDIRECT);
      expect(u.searchParams.get("error")).toBe(err);
      expect(u.searchParams.get("state")).toBe("xyz");
      expect(u.searchParams.get("iss")).toBe("http://localhost:3000");
    }
  });

  it("defaults scope to everything supported when omitted and accepts the exact resource", async () => {
    const s = await setup();
    const { params } = await validateAuthorizeRequest(
      s.raw({ scope: undefined, resource: mcpResourceUrl() }),
    );
    expect(params.scopes).toEqual(["proposals:create", "proposals:read"]);
  });
});

describe("consent", () => {
  it("issues a code that redeems for tokens bound to the chosen workspace and consented scopes", async () => {
    const s = await setup();
    const target = new URL(
      await approveAuthorization(s.owner, s.ws.id, s.raw({ scope: "proposals:read" })),
    );
    expect(target.searchParams.get("state")).toBe("xyz");
    const res = await tokenEndpoint(
      new Request("http://localhost:3000/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: s.client.client_id,
          code: target.searchParams.get("code")!,
          redirect_uri: REDIRECT,
          code_verifier: s.verifier,
        }).toString(),
      }),
    );
    const t = await res.json();
    const v = await verifyAccessToken(t.access_token);
    expect(v).toMatchObject({ workspaceId: s.ws.id, userId: s.owner, scopes: ["proposals:read"] });
  });

  it("reuses one grant per client, user and workspace and keeps scopes to what was just consented", async () => {
    const s = await setup();
    await approveAuthorization(
      s.owner,
      s.ws.id,
      s.raw({ scope: "proposals:create proposals:read" }),
    );
    await approveAuthorization(s.owner, s.ws.id, s.raw({ scope: "proposals:read" }));
    const rows = await getDb().select().from(mcpGrants).where(eq(mcpGrants.workspaceId, s.ws.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopes).toEqual(["proposals:read"]);
  });

  it("refuses a workspace the user is not in, or holds only a viewer role in", async () => {
    const s = await setup();
    const stranger = await user(`x${Math.random()}@example.test`);
    await expect(approveAuthorization(stranger, s.ws.id, s.raw())).rejects.toMatchObject({
      code: "access_denied",
    });
    const viewer = await join(s.owner, s.ws.id, "viewer");
    await expect(approveAuthorization(viewer, s.ws.id, s.raw())).rejects.toMatchObject({
      code: "access_denied",
    });
    expect((await connectableWorkspaces(viewer)).some((w) => w.id === s.ws.id)).toBe(false);
    expect((await connectableWorkspaces(s.owner)).some((w) => w.id === s.ws.id)).toBe(true);
  });

  it("denial returns access_denied to the verified redirect URI", async () => {
    const s = await setup();
    const u = new URL(await denyAuthorization(s.raw()));
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("code")).toBeNull();
  });
});

describe("grant management", () => {
  async function granted() {
    const s = await setup();
    const member = await join(s.owner, s.ws.id, "member");
    await approveAuthorization(member, s.ws.id, s.raw());
    await approveAuthorization(s.owner, s.ws.id, s.raw());
    return { ...s, member };
  }

  it("shows owners every grant and members only their own", async () => {
    const s = await granted();
    expect(await listGrants(s.owner, s.ws.id)).toHaveLength(2);
    const mine = await listGrants(s.member, s.ws.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.mine).toBe(true);
  });

  it("lets a member revoke their own grant, ending its tokens, but not someone else's", async () => {
    const s = await granted();
    const ownerGrant = (await listGrants(s.owner, s.ws.id)).find((g) => g.mine)!;
    await expect(revokeGrant(s.member, ownerGrant.id)).rejects.toMatchObject({ code: "not_found" });
    const memberGrant = (await listGrants(s.member, s.ws.id))[0]!;
    await revokeGrant(s.member, memberGrant.id);
    expect(await listGrants(s.member, s.ws.id)).toHaveLength(0);
  });

  it("lets an owner revoke any grant, and hides other workspaces' grants", async () => {
    const s = await granted();
    const memberGrant = (await listGrants(s.owner, s.ws.id)).find((g) => !g.mine)!;
    const outsider = await setup();
    await expect(revokeGrant(outsider.owner, memberGrant.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await revokeGrant(s.owner, memberGrant.id);
    expect(await listGrants(s.owner, s.ws.id)).toHaveLength(1);
  });
});
