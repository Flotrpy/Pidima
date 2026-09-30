import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpClients, mcpGrants, users } from "@/db/schema";
import { can } from "@/lib/permissions";
import { getEnv } from "@/lib/env";
import { mcpResourceUrl } from "@/mcp/metadata";
import { ALL_MCP_SCOPES, parseScopes, type McpScope } from "@/mcp/scopes";
import { recordAudit } from "./audit";
import { loadMembership, requirePermission } from "./authz";
import { OAuthError, createAuthorizationCode, createGrant, revokeGrantTokens } from "./mcp-oauth";
import { listMemberships, WorkspaceError } from "./workspaces";

export type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: McpScope[];
  resource: string;
};

/** Thrown when the request cannot be trusted enough to redirect back to the client. */
export class AuthorizeFatal extends Error {}
/** A protocol error that may safely be returned to the (verified) redirect URI. */
export class AuthorizeRedirectable extends Error {
  constructor(
    public error: string,
    message: string,
    public redirectUri: string,
    public state: string | null,
  ) {
    super(message);
  }
}

export function readAuthorizeParams(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  return Object.fromEntries(
    [
      "client_id",
      "redirect_uri",
      "response_type",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "state",
      "resource",
    ].map((k) => [k, one(k)]),
  );
}

/**
 * Validates an authorization request. The client and redirect URI are checked FIRST and against the
 * registered values; only after that may errors be sent to the redirect URI.
 */
export async function validateAuthorizeRequest(raw: Record<string, string | undefined>) {
  if (!raw.client_id || !raw.redirect_uri)
    throw new AuthorizeFatal("Missing client_id or redirect_uri");
  const [client] = await getDb()
    .select()
    .from(mcpClients)
    .where(eq(mcpClients.clientId, raw.client_id));
  if (!client) throw new AuthorizeFatal("Unknown client");
  if (!client.redirectUris.includes(raw.redirect_uri))
    throw new AuthorizeFatal("redirect_uri does not match a registered value");

  const fail = (error: string, message: string) =>
    new AuthorizeRedirectable(error, message, raw.redirect_uri!, raw.state ?? null);
  if (raw.response_type !== "code")
    throw fail("unsupported_response_type", "Only response_type=code is supported");
  if (
    raw.code_challenge_method !== "S256" ||
    !raw.code_challenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(raw.code_challenge)
  ) {
    throw fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  // RFC 8707: the token must be for this resource. Default it when the client omits it.
  const resource = raw.resource ?? mcpResourceUrl();
  if (resource !== mcpResourceUrl()) throw fail("invalid_target", "Unknown resource");
  const scopes = raw.scope ? parseScopes(raw.scope) : [...ALL_MCP_SCOPES];
  if (!scopes || scopes.length === 0) throw fail("invalid_scope", "Unsupported scope requested");
  if (raw.state && raw.state.length > 512) throw fail("invalid_request", "state is too long");

  const params: AuthorizeParams = {
    clientId: client.clientId,
    redirectUri: raw.redirect_uri,
    state: raw.state ?? null,
    codeChallenge: raw.code_challenge,
    scopes,
    resource,
  };
  return { client, params };
}

function redirectWith(redirectUri: string, values: Record<string, string | null>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(values)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", getEnv().APP_URL.replace(/\/$/, ""));
  return u.toString();
}

export const errorRedirect = (e: AuthorizeRedirectable) =>
  redirectWith(e.redirectUri, { error: e.error, error_description: e.message, state: e.state });

/** Workspaces where this user may connect AI clients. */
export async function connectableWorkspaces(userId: string) {
  return (await listMemberships(userId))
    .filter((m) => can(m.role, "clients.connect"))
    .map((m) => ({ id: m.workspace.id, name: m.workspace.name }));
}

export async function approveAuthorization(
  userId: string,
  workspaceId: string,
  raw: Record<string, string | undefined>,
): Promise<string> {
  const { client, params } = await validateAuthorizeRequest(raw);
  // The chosen workspace comes from the browser: verify membership and permission server-side.
  const membership = await loadMembership(userId, workspaceId);
  if (!membership || !can(membership.role, "clients.connect"))
    throw new OAuthError("access_denied", "You cannot connect AI clients to that workspace", 403);

  const [existing] = await getDb()
    .select()
    .from(mcpGrants)
    .where(
      and(
        eq(mcpGrants.mcpClientId, client.id),
        eq(mcpGrants.userId, userId),
        eq(mcpGrants.workspaceId, workspaceId),
        isNull(mcpGrants.revokedAt),
      ),
    );
  let grantId: string;
  if (existing) {
    grantId = existing.id;
    // Consent covers exactly what was just shown; never widen silently.
    await getDb()
      .update(mcpGrants)
      .set({ scopes: params.scopes })
      .where(eq(mcpGrants.id, existing.id));
  } else {
    grantId = (
      await createGrant({ clientDbId: client.id, userId, workspaceId, scopes: params.scopes })
    ).id;
  }
  const code = await createAuthorizationCode({
    grantId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    resource: params.resource,
  });
  await recordAudit({
    workspaceId,
    actorType: "user",
    actorId: userId,
    action: "mcp.consent_approved",
    subjectType: "mcp_grant",
    subjectId: grantId,
    detail: { client: client.name, scopes: params.scopes },
  });
  return redirectWith(params.redirectUri, { code, state: params.state });
}

export async function denyAuthorization(raw: Record<string, string | undefined>): Promise<string> {
  const { params } = await validateAuthorizeRequest(raw);
  return redirectWith(params.redirectUri, {
    error: "access_denied",
    error_description: "The user denied the request",
    state: params.state,
  });
}

export type GrantView = {
  id: string;
  clientName: string;
  userName: string;
  scopes: string[];
  createdAt: Date;
  lastActivityAt: Date | null;
  mine: boolean;
};

/** Owners see every grant in the workspace; others see only their own. */
export async function listGrants(actorId: string, workspaceId: string): Promise<GrantView[]> {
  const m = await requirePermission(actorId, workspaceId, "clients.connect");
  const rows = await getDb()
    .select({ g: mcpGrants, clientName: mcpClients.name, userName: users.name })
    .from(mcpGrants)
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.mcpClientId))
    .innerJoin(users, eq(users.id, mcpGrants.userId))
    .where(and(eq(mcpGrants.workspaceId, workspaceId), isNull(mcpGrants.revokedAt)))
    .orderBy(desc(mcpGrants.createdAt));
  return rows
    .filter((r) => m.role === "owner" || r.g.userId === actorId)
    .map((r) => ({
      id: r.g.id,
      clientName: r.clientName,
      userName: r.userName,
      scopes: r.g.scopes,
      createdAt: r.g.createdAt,
      lastActivityAt: r.g.lastActivityAt,
      mine: r.g.userId === actorId,
    }));
}

export async function revokeGrant(actorId: string, grantId: string) {
  const [g] = await getDb().select().from(mcpGrants).where(eq(mcpGrants.id, grantId));
  if (!g) throw new WorkspaceError("not_found", "Grant not found");
  const m = await loadMembership(actorId, g.workspaceId);
  // Non-members and non-owners revoking someone else's grant get the same "not found".
  if (!m || (g.userId !== actorId && m.role !== "owner"))
    throw new WorkspaceError("not_found", "Grant not found");
  await getDb()
    .update(mcpGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpGrants.id, grantId), isNull(mcpGrants.revokedAt)));
  await revokeGrantTokens(grantId, "mcp.grant_revoked");
  await recordAudit({
    workspaceId: g.workspaceId,
    actorType: "user",
    actorId,
    action: "mcp.grant_revoked_by_user",
    subjectType: "mcp_grant",
    subjectId: grantId,
  });
}
