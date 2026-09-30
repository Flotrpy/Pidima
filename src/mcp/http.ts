import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getEnv } from "@/lib/env";
import { createMcpServer, type McpPrincipal } from "./server";

export const MAX_MCP_BODY_BYTES = 256 * 1024;

/** Extra origins allowed to call the endpoint from a browser (comma-separated). */
function allowedOrigins(): Set<string> {
  const set = new Set<string>([
    new URL(getEnv().APP_URL).origin,
    "https://claude.ai",
    "https://claude.com",
  ]);
  for (const o of (process.env.MCP_ALLOWED_ORIGINS ?? "").split(","))
    if (o.trim()) set.add(o.trim());
  return set;
}

export type Authenticated = { authInfo: AuthInfo; principal: McpPrincipal };
export type Authenticator = (req: Request) => Promise<Authenticated | null>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins().has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers":
      "authorization, content-type, mcp-protocol-version, mcp-session-id, accept",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    "access-control-expose-headers": "www-authenticate, mcp-session-id",
    vary: "Origin",
  };
}

/** Builds the WWW-Authenticate challenge. Resource-metadata discovery is added in P1-023. */
export function challenge(resourceMetadataUrl?: string): string {
  return resourceMetadataUrl ? `Bearer resource_metadata="${resourceMetadataUrl}"` : "Bearer";
}

export async function handleMcpRequest(
  req: Request,
  authenticate: Authenticator,
  resourceMetadataUrl?: string,
): Promise<Response> {
  const origin = req.headers.get("origin");
  // DNS-rebinding protection: a browser-supplied Origin must be one we recognise.
  if (origin && !allowedOrigins().has(origin)) return json(403, { error: "origin_not_allowed" });
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES)
    return json(413, { error: "request_too_large" }, cors);

  const auth = await authenticate(req);
  if (!auth) {
    return json(
      401,
      { error: "unauthorized" },
      { ...cors, "www-authenticate": challenge(resourceMetadataUrl) },
    );
  }

  const server = createMcpServer(auth.principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { authInfo: auth.authInfo });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  } finally {
    // Stateless: release the per-request server as soon as the response is built.
    await server.close().catch(() => undefined);
  }
}
