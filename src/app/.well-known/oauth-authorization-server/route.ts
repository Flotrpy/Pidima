import { authorizationServerMetadata, metadataResponse } from "@/mcp/metadata";

export const dynamic = "force-dynamic";

export function GET() {
  return metadataResponse(authorizationServerMetadata());
}
