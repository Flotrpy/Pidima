import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { handleMcpRequest, MAX_MCP_BODY_BYTES, type Authenticator } from "@/mcp/http";
import { MCP_SERVER_INFO } from "@/mcp/server";

const URL_ = "http://localhost:3000/api/mcp";
const authed: Authenticator = async () => ({
  authInfo: { token: "t", clientId: "c", scopes: ["proposals:create"] },
  principal: {
    grantId: "g",
    userId: "u",
    workspaceId: "w",
    clientLabel: "Claude",
    scopes: ["proposals:create"],
  },
});
const anon: Authenticator = async () => null;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("remote MCP endpoint (Streamable HTTP)", () => {
  it("completes initialize with a real MCP client and negotiates the latest protocol", async () => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (input, init) => handleMcpRequest(new Request(input as string, init), authed),
    });
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject(MCP_SERVER_INFO);
    expect(transport.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    await client.close();
  });

  it("challenges unauthenticated callers with 401 and never reaches the MCP layer", async () => {
    const res = await handleMcpRequest(
      post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      anon,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects unknown browser origins to prevent DNS rebinding", async () => {
    const res = await handleMcpRequest(post({}, { origin: "https://evil.test" }), authed);
    expect(res.status).toBe(403);
  });

  it("answers CORS preflight only for allowed origins", async () => {
    const ok = await handleMcpRequest(
      new Request(URL_, { method: "OPTIONS", headers: { origin: "https://claude.ai" } }),
      anon,
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    const bad = await handleMcpRequest(
      new Request(URL_, { method: "OPTIONS", headers: { origin: "https://evil.test" } }),
      anon,
    );
    expect(bad.status).toBe(403);
  });

  it("rejects oversized request bodies", async () => {
    const res = await handleMcpRequest(
      new Request(URL_, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_MCP_BODY_BYTES + 1),
        },
        body: "{}",
      }),
      authed,
    );
    expect(res.status).toBe(413);
  });

  it("returns a JSON-RPC error for malformed JSON instead of throwing", async () => {
    const res = await handleMcpRequest(
      new Request(URL_, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "{not json",
      }),
      authed,
    );
    expect(res.status).toBe(400);
  });
});
