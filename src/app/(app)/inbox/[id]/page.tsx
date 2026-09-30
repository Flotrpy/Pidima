import { notFound } from "next/navigation";
import { DecisionBar } from "@/components/inbox/DecisionBar";
import { canDecide } from "@/lib/permissions";
import { loadMembership } from "@/server/authz";
import { InboxList } from "@/components/inbox/InboxList";
import { ReviewPanel } from "@/components/inbox/ReviewPanel";
import { requireActiveContext } from "@/server/active-workspace";
import { countsByFilter, getProposalDetail, isFilterKey, listProposals } from "@/server/inbox";
import { WorkspaceError } from "@/server/workspaces";

export const metadata = { title: "Review action" };
export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ f?: string }>;
}) {
  const { user, workspace } = await requireActiveContext();
  const { id } = await params;
  const sp = await searchParams;
  let detail;
  try {
    detail = await getProposalDetail(user.id, workspace.id, id);
  } catch (e) {
    if (e instanceof WorkspaceError && (e.code === "not_found" || e.code === "forbidden"))
      notFound();
    throw e;
  }
  const m = await loadMembership(user.id, workspace.id);
  const canApprove = !!m && canDecide(m.role, m.approvalCapabilities, detail.capability as never);
  const canWithdraw =
    (detail.state === "PENDING_APPROVAL" || detail.state === "APPROVED") &&
    (canApprove || detail.requestedById === user.id);
  const canEdit =
    detail.state === "PENDING_APPROVAL" &&
    !!m &&
    canDecide(m.role, m.approvalCapabilities, detail.capability as never);
  const filter = isFilterKey(sp.f) ? sp.f : "needs_review";
  const [counts, { items, nextCursor }] = await Promise.all([
    countsByFilter(user.id, workspace.id),
    listProposals(user.id, workspace.id, filter),
  ]);
  return (
    <div className="inbox-grid inbox-grid-detail">
      <InboxList
        filter={filter}
        counts={counts}
        items={items}
        nextCursor={nextCursor}
        selectedId={id}
      />
      <div className="inbox-detail">
        <ReviewPanel
          d={detail}
          footer={
            detail.state === "PENDING_APPROVAL" || detail.state === "APPROVED" ? (
              <DecisionBar
                proposalId={detail.id}
                version={detail.version}
                capability={detail.capability}
                canDecide={detail.state === "PENDING_APPROVAL" && canApprove}
                canEdit={canEdit}
                canCancel={canWithdraw}
                blockers={detail.blockers}
              />
            ) : null
          }
        />
      </div>
    </div>
  );
}
