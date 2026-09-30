import { notFound } from "next/navigation";
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
        <ReviewPanel d={detail} />
      </div>
    </div>
  );
}
