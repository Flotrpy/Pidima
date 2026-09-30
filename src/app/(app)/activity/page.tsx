import Link from "next/link";
import { RelativeTime } from "@/components/inbox/RelativeTime";
import { requireActiveContext } from "@/server/active-workspace";
import {
  ACTIVITY_CATEGORIES,
  describeAction,
  isActivityCategory,
  listActivity,
  type ActivityCategory,
} from "@/server/activity";

export const metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; cursor?: string; c?: string }>;
}) {
  const { user, workspace } = await requireActiveContext();
  const sp = await searchParams;
  const cat: ActivityCategory = isActivityCategory(sp.f) ? sp.f : "all";
  const { items, nextCursor } = await listActivity(user.id, workspace.id, cat, sp.cursor, sp.c);
  return (
    <div className="stack" style={{ ["--gap" as string]: "16px" }}>
      <div>
        <h1>Activity</h1>
        <p className="muted">
          A record of security-relevant and action events in {workspace.name}. Message bodies and
          credentials are never stored here.
          {sp.c ? ` Filtered to one request (correlation ${sp.c.slice(0, 8)}…).` : ""}
        </p>
      </div>
      <nav aria-label="Activity filters">
        <ul className="filters plain-list">
          {(Object.keys(ACTIVITY_CATEGORIES) as ActivityCategory[]).map((k) => (
            <li key={k}>
              <Link
                href={`/activity?f=${k}`}
                className="filter"
                aria-current={k === cat ? "page" : undefined}
              >
                {ACTIVITY_CATEGORIES[k].label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {items.length === 0 ? (
        <p className="alert" role="status">
          No activity recorded yet.
        </p>
      ) : (
        <ol className="card plain-list" aria-label="Activity timeline">
          {items.map((e) => (
            <li key={e.id} className="list-row stack" style={{ ["--gap" as string]: "4px" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{describeAction(e.action)}</strong>
                <span className="muted">
                  <RelativeTime iso={e.at.toISOString()} />
                </span>
              </div>
              <div className="muted">
                by {e.actor}
                {e.subjectType === "proposal" && e.subjectId ? (
                  <>
                    {" "}
                    · <Link href={`/inbox/${e.subjectId}`}>view request</Link>
                  </>
                ) : null}
                {e.correlationId ? (
                  <>
                    {" "}
                    · <Link href={`/activity?c=${e.correlationId}`}>related events</Link>
                  </>
                ) : null}
              </div>
              {Object.keys(e.detail).length > 0 ? (
                <details>
                  <summary className="hint">Details</summary>
                  <pre className="longtext">{JSON.stringify(e.detail, null, 2)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {nextCursor ? (
        <Link
          className="btn btn-sm"
          href={`/activity?f=${cat}&cursor=${nextCursor}${sp.c ? `&c=${sp.c}` : ""}`}
        >
          Load older
        </Link>
      ) : null}
    </div>
  );
}
