import { OAuthError, revokeToken } from "@/server/mcp-oauth";
import { oauthErrorResponse, readForm } from "@/server/oauth-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const form = await readForm(req);
    const clientId = form.get("client_id");
    const token = form.get("token");
    if (!clientId || !token)
      throw new OAuthError("invalid_request", "client_id and token are required");
    await revokeToken({ clientId, token });
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return oauthErrorResponse(e);
  }
}
