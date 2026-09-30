import Link from "next/link";
import { notFound } from "next/navigation";
import { ReceiptView } from "@/components/receipts/ReceiptView";
import { requireActiveContext } from "@/server/active-workspace";
import { getReceipt, getReceiptsForProposal, receiptNumber } from "@/server/receipts";
import { WorkspaceError } from "@/server/workspaces";

export const metadata = { title: "Receipt" };
export const dynamic = "force-dynamic";

async function load(userId: string, workspaceId: string, id: string) {
  try {
    const r = await getReceipt(userId, workspaceId, id);
    const all = await getReceiptsForProposal(userId, workspaceId, r.body.proposal.id);
    return { r, all };
  } catch (e) {
    if (e instanceof WorkspaceError) return null;
    throw e;
  }
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, workspace } = await requireActiveContext();
  const { id } = await params;
  const data = await load(user.id, workspace.id, id);
  if (!data) notFound();
  return (
    <div className="stack">
      <div className="row no-print">
        <Link href="/history" className="btn btn-sm">
          ← History
        </Link>
        <Link href={`/receipts/${id}/print`} className="btn btn-sm">
          Print view
        </Link>
        <a href={`/api/receipts/${id}/export`} className="btn btn-sm" download>
          Download JSON
        </a>
      </div>
      <ReceiptView
        body={data.r.body}
        linked={data.all.map((a) => ({ id: a.id, number: receiptNumber(a.id), kind: a.kind }))}
      />
    </div>
  );
}
