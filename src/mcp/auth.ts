import { verifyAccessToken } from "@/server/mcp-oauth";
import { mcpResourceUrl } from "./metadata";
import type { Authenticator } from "./http";

/** Verifies `Authorization: Bearer <token>` against stored, audience-bound, revocable tokens. */
export const authenticateBearer: Authenticator = async (req) => {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  if (!match) return null;
  const v = await verifyAccessToken(match[1]!);
  if (!v) return null;
  return {
    authInfo: {
      token: "[redacted]",
      clientId: v.clientId,
      scopes: v.scopes,
      expiresAt: v.expiresAt,
      resource: new URL(mcpResourceUrl()),
    },
    principal: {
      grantId: v.grantId,
      userId: v.userId,
      workspaceId: v.workspaceId,
      clientLabel: v.clientName,
      scopes: v.scopes,
    },
  };
};
