import { requireActiveContext } from "@/server/active-workspace";
import { exportReceipt } from "@/server/receipts";
import { WorkspaceError } from "@/server/workspaces";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, workspace } = await requireActiveContext();
  try {
    const { filename, json } = await exportReceipt(user.id, workspace.id, (await params).id);
    return new Response(json, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof WorkspaceError) return new Response("Not found", { status: 404 });
    return new Response("Export unavailable", { status: 500 });
  }
}
