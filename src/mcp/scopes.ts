/** Scopes an MCP client may be granted. Note: there is deliberately no scope that can approve or execute. */
export const MCP_SCOPES = {
  "proposals:create":
    "Propose actions for human review. Nothing is executed until a person approves.",
  "proposals:read": "Read the status of proposals this client created.",
} as const;

export type McpScope = keyof typeof MCP_SCOPES;
export const ALL_MCP_SCOPES = Object.keys(MCP_SCOPES) as McpScope[];

export function parseScopes(input: string | null | undefined): McpScope[] | null {
  if (!input) return [];
  const requested = input.split(/\s+/).filter(Boolean);
  if (requested.some((s) => !(s in MCP_SCOPES))) return null;
  return [...new Set(requested)] as McpScope[];
}
