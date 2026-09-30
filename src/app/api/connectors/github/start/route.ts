import { NextResponse } from "next/server";
import { isScopeLevel } from "@/connectors/github/api";
import { getEnv } from "@/lib/env";
import { requireActiveContext } from "@/server/active-workspace";
import { GithubConnectError, startGithubConnect } from "@/server/github-connect";
import { isSameSiteNavigation } from "@/server/route-guards";
import { WorkspaceError } from "@/server/workspaces";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const back = (code: string) =>
    NextResponse.redirect(new URL(`/connections?connect_error=${code}`, getEnv().APP_URL));
  if (!isSameSiteNavigation(req)) return back("invalid");
  const { user, workspace } = await requireActiveContext();
  const level = new URL(req.url).searchParams.get("access");
  try {
    const url = await startGithubConnect({
      userId: user.id,
      workspaceId: workspace.id,
      level: isScopeLevel(level) ? level : "public",
      returnTo: "/connections",
    });
    return NextResponse.redirect(url);
  } catch (e) {
    if (e instanceof GithubConnectError) return back(e.code);
    if (e instanceof WorkspaceError) return back("forbidden");
    throw e;
  }
}
