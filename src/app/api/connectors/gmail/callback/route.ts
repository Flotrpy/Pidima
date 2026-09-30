import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { requireActiveContext } from "@/server/active-workspace";
import { GmailConnectError, completeGmailConnect } from "@/server/gmail-connect";
import { WorkspaceError } from "@/server/workspaces";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const app = getEnv().APP_URL;
  const { user } = await requireActiveContext();
  const p = new URL(req.url).searchParams;
  try {
    const r = await completeGmailConnect({
      userId: user.id,
      state: p.get("state"),
      code: p.get("code"),
      error: p.get("error"),
    });
    return NextResponse.redirect(new URL(`${r.returnTo}?connected=gmail`, app));
  } catch (e) {
    if (e instanceof GmailConnectError)
      return NextResponse.redirect(new URL(`/connections?connect_error=${e.code}`, app));
    if (e instanceof WorkspaceError)
      return NextResponse.redirect(new URL("/connections?connect_error=forbidden", app));
    throw e;
  }
}
