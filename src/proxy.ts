import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = [
  "/inbox",
  "/history",
  "/connections",
  "/clients",
  "/policies",
  "/team",
  "/settings",
  "/invite",
  "/onboarding",
  "/authorize",
];

/**
 * Optimistic gate: requests without any session cookie go to sign-in with a validated return
 * path. This is only a fast path. Pages and actions verify the session and role server-side.
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (!PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
    return NextResponse.next();
  if (getSessionCookie(req)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = `?returnTo=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/|api/|favicon.ico).*)"] };
