import { OAuthError, exchangeAuthorizationCode, refreshTokens } from "@/server/mcp-oauth";
import { oauthErrorResponse, oauthJson, readForm } from "@/server/oauth-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const form = await readForm(req);
    const clientId = form.get("client_id");
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
    switch (form.get("grant_type")) {
      case "authorization_code": {
        const code = form.get("code");
        const redirectUri = form.get("redirect_uri");
        const verifier = form.get("code_verifier");
        if (!code || !redirectUri || !verifier)
          throw new OAuthError(
            "invalid_request",
            "code, redirect_uri and code_verifier are required",
          );
        return oauthJson(
          200,
          await exchangeAuthorizationCode({
            clientId,
            code,
            redirectUri,
            codeVerifier: verifier,
            resource: form.get("resource") ?? undefined,
          }),
        );
      }
      case "refresh_token": {
        const refresh = form.get("refresh_token");
        if (!refresh) throw new OAuthError("invalid_request", "refresh_token is required");
        return oauthJson(200, await refreshTokens({ clientId, refreshToken: refresh }));
      }
      default:
        throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
    }
  } catch (e) {
    return oauthErrorResponse(e);
  }
}
