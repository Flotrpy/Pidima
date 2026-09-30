import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { requireActiveContext } from "@/server/active-workspace";
import { SlackConnectError, completeSlackConnect } from "@/server/slack-connect";
import { WorkspaceError } from "@/server/workspaces";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const app = getEnv().APP_URL;
  const { user } = await requireActiveContext();
  const p = new URL(req.url).searchParams;
  try {
    const r = await completeSlackConnect({
      userId: user.id,
      state: p.get("state"),
      code: p.get("code"),
      error: p.get("error"),
    });
    return NextResponse.redirect(
      new URL(`${r.returnTo}${r.returnTo.includes("?") ? "&" : "?"}connected=slack`, app),
    );
  } catch (e) {
    if (e instanceof SlackConnectError)
      return NextResponse.redirect(new URL(`/connections?connect_error=${e.code}`, app));
    if (e instanceof WorkspaceError)
      return NextResponse.redirect(new URL("/connections?connect_error=forbidden", app));
    throw e;
  }
}
