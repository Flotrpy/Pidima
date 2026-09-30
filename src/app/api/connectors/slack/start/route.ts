import { NextResponse } from "next/server";
import { isSenderMode } from "@/connectors/slack/api";
import { getEnv } from "@/lib/env";
import { requireActiveContext } from "@/server/active-workspace";
import { isSameSiteNavigation } from "@/server/route-guards";
import { SlackConnectError, startSlackConnect } from "@/server/slack-connect";
import { WorkspaceError } from "@/server/workspaces";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const back = (code: string) =>
    NextResponse.redirect(new URL(`/connections?connect_error=${code}`, getEnv().APP_URL));
  if (!isSameSiteNavigation(req)) return back("invalid");
  const { user, workspace } = await requireActiveContext();
  const sender = new URL(req.url).searchParams.get("sender");
  try {
    return NextResponse.redirect(
      await startSlackConnect({
        userId: user.id,
        workspaceId: workspace.id,
        mode: isSenderMode(sender) ? sender : "bot",
      }),
    );
  } catch (e) {
    if (e instanceof SlackConnectError) return back(e.code);
    if (e instanceof WorkspaceError) return back("forbidden");
    throw e;
  }
}
