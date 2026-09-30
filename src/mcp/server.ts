import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MCP_SERVER_INFO = { name: "ai-action-inbox", version: "0.1.0" } as const;

/**
 * Who is calling. Filled in from a verified access token in P1-024; nothing here trusts
 * client-supplied identity.
 */
export type McpPrincipal = {
  grantId: string;
  userId: string;
  workspaceId: string;
  clientLabel: string;
  scopes: string[];
};

/**
 * Stateless: a fresh server per request, so any instance can serve any request and there is
 * no session state to lose on restart. Proposal tools are attached in P1-026.
 */
export function createMcpServer(_principal: McpPrincipal): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      "AI Action Inbox proposes actions for human approval. Tools here never perform the action: they create a pending proposal that an authorized person reviews. Use action.get_status to follow a proposal.",
  });
  return server;
}
