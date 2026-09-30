import { describe, expect, it } from "vitest";
import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";
import { GET as authServer } from "@/app/.well-known/oauth-authorization-server/route";
import { handleMcpRequest } from "@/mcp/http";
import {
  authorizationServerMetadata,
  mcpResourceUrl,
  protectedResourceMetadataUrl,
} from "@/mcp/metadata";
import { authenticateBearer } from "@/mcp/auth";
import { ALL_MCP_SCOPES, parseScopes } from "@/mcp/scopes";

const ctx = (path?: string[]) => ({ params: Promise.resolve({ path }) });
const req = (u: string) => new Request(`http://localhost:3000${u}`);

describe("MCP authorization discovery", () => {
  it("publishes protected-resource metadata for the exact MCP resource", async () => {
    for (const path of [undefined, ["api", "mcp"]]) {
      const res = await protectedResource(req("/.well-known/oauth-protected-resource"), ctx(path));
      expect(res.status).toBe(200);
      const doc = await res.json();
      expect(doc.resource).toBe("http://localhost:3000/api/mcp");
      expect(doc.resource).toBe(mcpResourceUrl());
      expect(doc.authorization_servers).toEqual(["http://localhost:3000"]);
      expect(doc.bearer_methods_supported).toEqual(["header"]);
      expect(doc.scopes_supported).toEqual(ALL_MCP_SCOPES);
    }
  });

  it("does not answer for other resource paths", async () => {
    const res = await protectedResource(req("/x"), ctx(["api", "other"]));
    expect(res.status).toBe(404);
  });

  it("publishes authorization-server metadata that allows only code + PKCE S256", async () => {
    const doc = await (await authServer()).json();
    expect(doc.issuer).toBe("http://localhost:3000");
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.grant_types_supported).not.toContain("implicit");
    expect(doc.grant_types_supported).not.toContain("password");
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      expect(doc[k].startsWith(doc.issuer + "/")).toBe(true);
    }
    expect(authorizationServerMetadata().issuer).toBe(doc.issuer);
  });

  it("challenges unauthenticated MCP calls with a pointer to the metadata document", async () => {
    const res = await handleMcpRequest(
      new Request("http://localhost:3000/api/mcp", { method: "POST", body: "{}" }),
      authenticateBearer,
      protectedResourceMetadataUrl(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp"',
    );
  });

  it("exposes no scope capable of approving or executing", () => {
    expect(ALL_MCP_SCOPES.join(" ")).not.toMatch(/approve|execute|admin/);
    expect(parseScopes("proposals:create proposals:read")).toEqual([
      "proposals:create",
      "proposals:read",
    ]);
    expect(parseScopes("proposals:create admin")).toBeNull();
    expect(parseScopes("")).toEqual([]);
  });
});
