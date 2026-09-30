import Link from "next/link";
import { markNotificationsReadAction } from "@/app/actions/notifications";
import { Button } from "@/components/ui";
import { RelativeTime } from "@/components/inbox/RelativeTime";
import { requireActiveContext } from "@/server/active-workspace";
import { listNotifications } from "@/server/notifications";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

const TEXT = {
  review_requested: "An AI request is waiting for your review",
  execution_failed: "An approved action did not complete",
  outcome_unknown: "An approved action needs verification",
  connector_unhealthy: "A connection needs to be reconnected",
} as const;

export default async function NotificationsPage() {
  const { user, workspace } = await requireActiveContext();
  const items = (await listNotifications(user.id)).filter((n) => n.workspaceId === workspace.id);
  return (
    <div className="stack" style={{ ["--gap" as string]: "16px" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Notifications</h1>
        <form action={markNotificationsReadAction}>
          <Button type="submit" small>
            Mark all read
          </Button>
        </form>
      </div>
      {items.length === 0 ? (
        <p className="alert" role="status">
          You&apos;re all caught up.
        </p>
      ) : (
        <ul className="card plain-list">
          {items.map((n) => (
            <li key={n.id} className="row list-row">
              {n.readAt ? null : (
                <span className="badge badge-pending">
                  <span aria-hidden="true">●</span>
                  <span>New</span>
                </span>
              )}
              <Link
                href={n.proposalId ? `/inbox/${n.proposalId}` : "/connections"}
                style={{ flex: 1 }}
              >
                {TEXT[n.kind]}
              </Link>
              <span className="muted">
                <RelativeTime iso={n.createdAt.toISOString()} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
