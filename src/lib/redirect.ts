const DEFAULT_RETURN = "/inbox";

/**
 * Accepts only same-site relative paths. Rejects absolute and protocol-relative URLs,
 * backslash tricks, control characters, and anything that would round-trip through the
 * auth pages into a redirect loop.
 */
export function safeReturnTo(value: string | null | undefined, fallback = DEFAULT_RETURN): string {
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  // Check the decoded form too so %0d%0a, %5c and %2f%2f tricks are caught.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  for (const candidate of [value, decoded]) {
    if (
      /[\u0000-\u001f\u007f]/.test(candidate) ||
      candidate.includes("\\") ||
      candidate.startsWith("//")
    )
      return fallback;
  }
  let url: URL;
  try {
    url = new URL(value, "http://internal.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://internal.invalid") return fallback;
  if (url.pathname.startsWith("/sign-in") || url.pathname.startsWith("/api/")) return fallback;
  return url.pathname + url.search + url.hash;
}

const REDIRECT_KEYS = [
  "callbackURL",
  "newUserCallbackURL",
  "errorCallbackURL",
  "redirectTo",
] as const;

/**
 * True when every redirect-like parameter is a safe same-site relative path or an absolute URL
 * on this app's own origin. Anything else (other origins, schemes, tricks) is refused.
 */
export function redirectParamsAreSafe(
  params: Record<string, unknown> | undefined | null,
  appOrigin: string,
): boolean {
  if (!params) return true;
  for (const key of REDIRECT_KEYS) {
    const v = params[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return false;
    if (v.startsWith("/")) {
      if (safeReturnTo(v, "\0") === "\0" && !v.startsWith("/sign-in") && !v.startsWith("/api/"))
        return false;
      continue;
    }
    try {
      const u = new URL(v);
      if (u.origin !== appOrigin) return false;
    } catch {
      return false;
    }
  }
  return true;
}
