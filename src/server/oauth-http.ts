import "server-only";
import { OAuthError } from "./mcp-oauth";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export const oauthJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });

export function oauthErrorResponse(e: unknown) {
  if (e instanceof OAuthError)
    return oauthJson(e.status, { error: e.code, error_description: e.message });
  console.error("oauth endpoint failure");
  return oauthJson(500, { error: "server_error" });
}

/** Parses a form-encoded body of bounded size. */
export async function readForm(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded"))
    throw new OAuthError(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded",
    );
  const text = await req.text();
  if (text.length > 8192) throw new OAuthError("invalid_request", "Request too large");
  return new URLSearchParams(text);
}
