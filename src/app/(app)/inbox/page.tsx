import { redirect } from "next/navigation";
import { InboxList } from "@/components/inbox/InboxList";
import { SummaryStrip } from "@/components/inbox/SummaryStrip";
import { requireActiveContext } from "@/server/active-workspace";
import { can } from "@/lib/permissions";
import { countsByFilter, getOperationalSummary, isFilterKey, listProposals } from "@/server/inbox";
import { getOnboardingState, landingPath } from "@/server/onboarding";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; cursor?: string; q?: string; invite_error?: string }>;
}) {
  const { user, workspace, role } = await requireActiveContext();
  const sp = await searchParams;
  const onboarding = await getOnboardingState(workspace.id);
  if (landingPath(onboarding, role === "owner") === "/onboarding" && !sp.f) redirect("/onboarding");

  if (!can(role, "proposals.view")) {
    return (
      <>
        <h1>Inbox</h1>
        <p className="muted">
          Your role can read receipts and activity. Proposals are visible to owners, approvers and
          members.
        </p>
      </>
    );
  }
  const filter = isFilterKey(sp.f) ? sp.f : "needs_review";
  const [summary, counts, { items, nextCursor }] = await Promise.all([
    getOperationalSummary(user.id, workspace.id),
    countsByFilter(user.id, workspace.id),
    listProposals(user.id, workspace.id, filter, sp.cursor, sp.q),
  ]);
  return (
    <div className="stack" style={{ ["--gap" as string]: "20px" }}>
      <h1>Inbox</h1>
      {sp.invite_error ? (
        <p className="alert alert-error" role="alert">
          {sp.invite_error}
        </p>
      ) : null}
      <SummaryStrip s={summary} />
      <div className="inbox-grid">
        <InboxList filter={filter} counts={counts} items={items} nextCursor={nextCursor} q={sp.q} />
        <div className="inbox-detail inbox-detail-empty muted">
          Select a request to review the exact action.
        </div>
      </div>
    </div>
  );
}
