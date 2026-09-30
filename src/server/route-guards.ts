import "server-only";

/**
 * Browser navigations that start a state-changing flow must come from this site (a link click in
 * our UI) or be typed directly. Cross-site initiated requests are refused.
 */
export function isSameSiteNavigation(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}
