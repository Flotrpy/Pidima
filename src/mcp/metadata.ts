import { getEnv } from "@/lib/env";
import { ALL_MCP_SCOPES } from "./scopes";

export const MCP_PATH = "/api/mcp";

const base = () => getEnv().APP_URL.replace(/\/$/, "");

/** The canonical resource identifier tokens must be issued for (RFC 8707). */
export const mcpResourceUrl = () => `${base()}${MCP_PATH}`;

export const protectedResourceMetadataUrl = () =>
  `${base()}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** RFC 9728: tells a client which authorization server protects this resource. */
export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [base()],
    scopes_supported: ALL_MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "AI Action Inbox",
    resource_documentation: `${base()}/docs`,
  };
}

/** RFC 8414 authorization server metadata. Authorization code + PKCE (S256) only. */
export function authorizationServerMetadata() {
  return {
    issuer: base(),
    authorization_endpoint: `${base()}/authorize`,
    token_endpoint: `${base()}/api/oauth/token`,
    registration_endpoint: `${base()}/api/oauth/register`,
    revocation_endpoint: `${base()}/api/oauth/revoke`,
    scopes_supported: ALL_MCP_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${base()}/docs`,
  };
}

export function metadataResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      // Public discovery documents: browser-based clients must be able to read them.
      "access-control-allow-origin": "*",
    },
  });
}
