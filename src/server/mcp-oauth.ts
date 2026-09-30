import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mcpAuthorizationCodes, mcpClients, mcpGrants, mcpTokens } from "@/db/schema";
import { mcpResourceUrl } from "@/mcp/metadata";
import { ALL_MCP_SCOPES, type McpScope } from "@/mcp/scopes";
import { recordAudit } from "./audit";
import { loadMembership } from "./authz";
import { can } from "@/lib/permissions";
import { randomToken, sha256 } from "./tokens";

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
export const CODE_TTL_S = 60;

/** RFC 6749 error, rendered by the HTTP layer. */
export class OAuthError extends Error {
  constructor(
    public code:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "unauthorized_client"
      | "unsupported_grant_type"
      | "invalid_scope"
      | "invalid_target"
      | "invalid_client_metadata"
      | "invalid_redirect_uri"
      | "access_denied",
    description: string,
    public status = 400,
  ) {
    super(description);
  }
}

// ---------- Dynamic client registration (RFC 7591) ----------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isValidRedirectUri(uri: string): boolean {
  if (typeof uri !== "string" || uri.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

export async function registerClient(meta: unknown) {
  const m = (meta ?? {}) as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > 10 ||
    !uris.every((u) => typeof u === "string" && isValidRedirectUri(u))
  ) {
    throw new OAuthError(
      "invalid_redirect_uri",
      "redirect_uris must be 1-10 https URLs (or loopback http URLs) without fragments",
    );
  }
  const method = m.token_endpoint_auth_method ?? "none";
  if (method !== "none")
    throw new OAuthError(
      "invalid_client_metadata",
      "Only public clients (token_endpoint_auth_method=none) are supported; PKCE is required",
    );
  const grants = m.grant_types ?? ["authorization_code"];
  if (
    !Array.isArray(grants) ||
    grants.some((g) => g !== "authorization_code" && g !== "refresh_token")
  ) {
    throw new OAuthError("invalid_client_metadata", "Unsupported grant_types");
  }
  const name =
    typeof m.client_name === "string"
      ? m.client_name
          .replace(/[\u0000-\u001f]/g, "")
          .trim()
          .slice(0, 80)
      : "";
  const clientId = `mcp_${randomToken(18)}`;
  await getDb()
    .insert(mcpClients)
    .values({
      clientId,
      name: name || "Unnamed MCP client",
      redirectUris: [...new Set(uris as string[])],
    });
  return {
    client_id: clientId,
    client_name: name || "Unnamed MCP client",
    redirect_uris: [...new Set(uris as string[])],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: ALL_MCP_SCOPES.join(" "),
  };
}

export async function getClient(clientId: string) {
  const [c] = await getDb().select().from(mcpClients).where(eq(mcpClients.clientId, clientId));
  return c ?? null;
}

// ---------- Grants ----------

/** A user's consent binding one client to one workspace with explicit scopes. */
export async function createGrant(input: {
  clientDbId: string;
  userId: string;
  workspaceId: string;
  scopes: McpScope[];
}) {
  const m = await loadMembership(input.userId, input.workspaceId);
  if (!m || !can(m.role, "clients.connect"))
    throw new OAuthError(
      "access_denied",
      "You are not allowed to connect AI clients to this workspace",
      403,
    );
  if (input.scopes.length === 0 || input.scopes.some((s) => !ALL_MCP_SCOPES.includes(s)))
    throw new OAuthError("invalid_scope", "Unsupported scope");
  const [g] = await getDb()
    .insert(mcpGrants)
    .values({
      mcpClientId: input.clientDbId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      scopes: input.scopes,
    })
    .returning();
  await recordAudit({
    workspaceId: input.workspaceId,
    actorType: "user",
    actorId: input.userId,
    action: "mcp.grant_created",
    subjectType: "mcp_grant",
    subjectId: g!.id,
    detail: { scopes: input.scopes },
  });
  return g!;
}

// ---------- Authorization code (PKCE S256) ----------

const B64URL_43_128 = /^[A-Za-z0-9\-._~]{43,128}$/;

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function createAuthorizationCode(input: {
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge))
    throw new OAuthError("invalid_request", "code_challenge must be a base64url SHA-256 value");
  if (input.resource !== mcpResourceUrl())
    throw new OAuthError("invalid_target", "Unknown resource");
  const code = randomToken(32);
  await getDb()
    .insert(mcpAuthorizationCodes)
    .values({
      codeHash: sha256(code),
      grantId: input.grantId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      resource: input.resource,
      expiresAt: new Date(Date.now() + CODE_TTL_S * 1000),
    });
  return code;
}

type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

async function issueTokens(grantId: string, scopes: string[]): Promise<TokenResponse> {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const audience = mcpResourceUrl();
  await getDb()
    .insert(mcpTokens)
    .values([
      {
        tokenHash: sha256(access),
        kind: "access",
        grantId,
        audience,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000),
      },
      {
        tokenHash: sha256(refresh),
        kind: "refresh",
        grantId,
        audience,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000),
      },
    ]);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refresh,
    scope: scopes.join(" "),
  };
}

async function activeGrant(grantId: string, clientId: string) {
  const [row] = await getDb()
    .select({ grant: mcpGrants, clientId: mcpClients.clientId })
    .from(mcpGrants)
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.mcpClientId))
    .where(and(eq(mcpGrants.id, grantId), isNull(mcpGrants.revokedAt)));
  if (!row || row.clientId !== clientId) return null;
  return row.grant;
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
}) {
  if (!B64URL_43_128.test(input.codeVerifier))
    throw new OAuthError("invalid_grant", "Invalid code_verifier");
  if (input.resource && input.resource !== mcpResourceUrl())
    throw new OAuthError("invalid_target", "Unknown resource");

  // Atomic single use: replays and concurrent exchanges find nothing to update.
  const [row] = await getDb()
    .update(mcpAuthorizationCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(mcpAuthorizationCodes.codeHash, sha256(input.code)),
        isNull(mcpAuthorizationCodes.consumedAt),
        gt(mcpAuthorizationCodes.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row)
    throw new OAuthError("invalid_grant", "Authorization code is invalid, expired or already used");

  const grant = await activeGrant(row.grantId, input.clientId);
  if (
    !grant ||
    row.redirectUri !== input.redirectUri ||
    row.codeChallenge !== pkceChallenge(input.codeVerifier)
  ) {
    // Any mismatch burns the code (already consumed above) and reveals nothing specific.
    throw new OAuthError("invalid_grant", "Authorization code is invalid, expired or already used");
  }
  return issueTokens(grant.id, grant.scopes);
}

export async function refreshTokens(input: { clientId: string; refreshToken: string }) {
  const hash = sha256(input.refreshToken);
  const [used] = await getDb()
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokens.tokenHash, hash),
        eq(mcpTokens.kind, "refresh"),
        isNull(mcpTokens.revokedAt),
        gt(mcpTokens.expiresAt, new Date()),
      ),
    )
    .returning();

  if (!used) {
    // A revoked (already rotated) refresh token being replayed suggests theft: kill the family.
    const [old] = await getDb()
      .select()
      .from(mcpTokens)
      .where(and(eq(mcpTokens.tokenHash, hash), eq(mcpTokens.kind, "refresh")));
    if (old?.revokedAt) await revokeGrantTokens(old.grantId, "mcp.refresh_reuse_detected");
    throw new OAuthError("invalid_grant", "Refresh token is invalid or expired");
  }
  const grant = await activeGrant(used.grantId, input.clientId);
  if (!grant) throw new OAuthError("invalid_grant", "Refresh token is invalid or expired");
  return issueTokens(grant.id, grant.scopes);
}

export async function revokeGrantTokens(grantId: string, auditAction = "mcp.tokens_revoked") {
  await getDb()
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.grantId, grantId), isNull(mcpTokens.revokedAt)));
  const [g] = await getDb()
    .select({ workspaceId: mcpGrants.workspaceId })
    .from(mcpGrants)
    .where(eq(mcpGrants.id, grantId));
  await recordAudit({
    workspaceId: g?.workspaceId,
    actorType: "system",
    action: auditAction,
    subjectType: "mcp_grant",
    subjectId: grantId,
  });
}

/** RFC 7009: always succeeds from the caller's view, and only revokes tokens the client owns. */
export async function revokeToken(input: { clientId: string; token: string }) {
  const [t] = await getDb()
    .select()
    .from(mcpTokens)
    .where(eq(mcpTokens.tokenHash, sha256(input.token)));
  if (!t) return;
  const grant = await activeGrant(t.grantId, input.clientId);
  if (!grant) return;
  if (t.kind === "refresh") await revokeGrantTokens(t.grantId);
  else
    await getDb()
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(eq(mcpTokens.tokenHash, t.tokenHash));
}

// ---------- Bearer verification ----------

export type VerifiedToken = {
  grantId: string;
  userId: string;
  workspaceId: string;
  clientId: string;
  clientName: string;
  scopes: McpScope[];
  expiresAt: number;
};

const ACTIVITY_THROTTLE_MS = 60_000;

/** Verifies audience, expiry, revocation and that the granting user still holds access. */
export async function verifyAccessToken(token: string): Promise<VerifiedToken | null> {
  if (!token || token.length > 200) return null;
  const [row] = await getDb()
    .select({
      t: mcpTokens,
      grant: mcpGrants,
      clientId: mcpClients.clientId,
      clientName: mcpClients.name,
    })
    .from(mcpTokens)
    .innerJoin(mcpGrants, eq(mcpGrants.id, mcpTokens.grantId))
    .innerJoin(mcpClients, eq(mcpClients.id, mcpGrants.mcpClientId))
    .where(eq(mcpTokens.tokenHash, sha256(token)));
  if (!row || row.t.kind !== "access" || row.t.revokedAt || row.grant.revokedAt) return null;
  if (row.t.expiresAt.getTime() <= Date.now()) return null;
  // Tokens are only valid for this resource (RFC 8707): never accept one minted for anything else.
  if (row.t.audience !== mcpResourceUrl()) return null;

  const m = await loadMembership(row.grant.userId, row.grant.workspaceId);
  if (!m || !can(m.role, "clients.connect")) return null;

  if (
    !row.grant.lastActivityAt ||
    Date.now() - row.grant.lastActivityAt.getTime() > ACTIVITY_THROTTLE_MS
  ) {
    await getDb()
      .update(mcpGrants)
      .set({ lastActivityAt: new Date() })
      .where(eq(mcpGrants.id, row.grant.id));
  }
  return {
    grantId: row.grant.id,
    userId: row.grant.userId,
    workspaceId: row.grant.workspaceId,
    clientId: row.clientId,
    clientName: row.clientName,
    scopes: row.grant.scopes as McpScope[],
    expiresAt: Math.floor(row.t.expiresAt.getTime() / 1000),
  };
}
