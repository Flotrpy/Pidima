import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { requireActiveContext } from "@/server/active-workspace";
import { GmailConnectError, startGmailConnect } from "@/server/gmail-connect";
import { isSameSiteNavigation } from "@/server/route-guards";
import { WorkspaceError } from "@/server/workspaces";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const back = (c: string) =>
    NextResponse.redirect(new URL(`/connections?connect_error=${c}`, getEnv().APP_URL));
  if (!isSameSiteNavigation(req)) return back("invalid");
  const { user, workspace } = await requireActiveContext();
  try {
    return NextResponse.redirect(
      await startGmailConnect({ userId: user.id, workspaceId: workspace.id }),
    );
  } catch (e) {
    if (e instanceof GmailConnectError) return back(e.code);
    if (e instanceof WorkspaceError) return back("forbidden");
    throw e;
  }
}
