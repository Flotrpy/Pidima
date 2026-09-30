import { MCP_PATH, metadataResponse, protectedResourceMetadata } from "@/mcp/metadata";

export const dynamic = "force-dynamic";

/** Serves `/.well-known/oauth-protected-resource` and the path-scoped form for `/api/mcp`. */
export async function GET(_req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const path = `/${((await params).path ?? []).join("/")}`;
  if (path !== "/" && path !== MCP_PATH) return new Response("Not found", { status: 404 });
  return metadataResponse(protectedResourceMetadata());
}
