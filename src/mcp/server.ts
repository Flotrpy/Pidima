import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Capability } from "@/lib/permissions";
import { availableCapabilities } from "@/server/policy";
import { callProposeTool } from "@/server/mcp-tools";
import { TOOL_DEFS } from "./tool-defs";

export const MCP_SERVER_INFO = { name: "ai-action-inbox", version: "0.1.0" } as const;

/**
 * Who is calling, taken from a verified access token (never from client-supplied input).
 */
export type McpPrincipal = {
  grantId: string;
  userId: string;
  workspaceId: string;
  clientLabel: string;
  scopes: string[];
};

/**
 * Stateless: a fresh server per request, so tool discovery always reflects current connectors,
 * policy and grant state, and any instance can serve any request. Only capabilities that are
 * currently available are registered. That is a convenience for the client: each call is still
 * re-authorized in `callProposeTool`.
 */
export async function createMcpServer(principal: McpPrincipal): Promise<McpServer> {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      "AI Action Inbox proposes actions for human approval. Tools here never perform the action: they create a pending proposal that an authorized person reviews. Use action.get_status to follow a proposal.",
  });

  const available = principal.scopes.includes("proposals:create")
    ? await availableCapabilities(principal.grantId)
    : [];
  for (const capability of available as Capability[]) {
    const def = TOOL_DEFS[capability];
    server.registerTool(
      capability,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input, extra) => {
        const r = await callProposeTool(
          principal,
          capability,
          input as Record<string, unknown>,
          extra.authInfo?.clientId,
        );
        return {
          isError: r.isError,
          content: [{ type: "text" as const, text: r.text }],
          ...(r.structured ? { structuredContent: r.structured } : {}),
        };
      },
    );
  }
  if (available.length === 0) {
    // With no tools registered the SDK would answer tools/list with "method not found".
    // Install its tool handlers anyway so an empty list is returned (honest: nothing is offered).
    (server as unknown as { setToolRequestHandlers(): void }).setToolRequestHandlers();
  }
  return server;
}
