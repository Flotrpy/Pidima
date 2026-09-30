import "server-only";
import { getEnv } from "@/lib/env";

export class CsrfError extends Error {
  constructor() {
    super("Cross-site request rejected");
  }
}

/**
 * Cookie-authenticated mutations must originate from this app. Requires a matching Origin,
 * or (when Origin is absent) a browser-asserted same-origin Sec-Fetch-Site. Requests carrying
 * neither are rejected. Bearer-token (MCP) endpoints do not use cookies and skip this.
 */
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const expected = new URL(getEnv().APP_URL).origin;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin !== expected) throw new CsrfError();
    return;
  }
  if (req.headers.get("sec-fetch-site") === "same-origin") return;
  throw new CsrfError();
}
