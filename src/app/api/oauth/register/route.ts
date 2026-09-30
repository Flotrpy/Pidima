import { oauthErrorResponse, oauthJson } from "@/server/oauth-http";
import { registerClient } from "@/server/mcp-oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (text.length > 16_384)
      return oauthJson(413, {
        error: "invalid_client_metadata",
        error_description: "Request too large",
      });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return oauthJson(400, {
        error: "invalid_client_metadata",
        error_description: "Body must be JSON",
      });
    }
    return oauthJson(201, await registerClient(body));
  } catch (e) {
    return oauthErrorResponse(e);
  }
}
