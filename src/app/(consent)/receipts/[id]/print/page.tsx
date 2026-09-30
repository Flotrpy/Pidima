import { notFound } from "next/navigation";
import { ReceiptView } from "@/components/receipts/ReceiptView";
import { PrintButton } from "@/components/receipts/PrintButton";
import { requireActiveContext } from "@/server/active-workspace";
import { getReceipt } from "@/server/receipts";
import { WorkspaceError } from "@/server/workspaces";

export const metadata = { title: "Print receipt" };
export const dynamic = "force-dynamic";

async function load(userId: string, workspaceId: string, id: string) {
  try {
    return await getReceipt(userId, workspaceId, id);
  } catch (e) {
    if (e instanceof WorkspaceError) return null;
    throw e;
  }
}

export default async function PrintReceipt({ params }: { params: Promise<{ id: string }> }) {
  const { user, workspace } = await requireActiveContext();
  const r = await load(user.id, workspace.id, (await params).id);
  if (!r) notFound();
  return (
    <div className="print-page">
      <div className="no-print" style={{ marginBottom: 16 }}>
        <PrintButton />
      </div>
      <ReceiptView body={r.body} />
    </div>
  );
}
