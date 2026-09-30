import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { RelativeTime } from "@/components/inbox/RelativeTime";
import { requireActiveContext } from "@/server/active-workspace";
import {
  HISTORY_FILTERS,
  isHistoryFilter,
  listHistory,
  type HistoryFilter,
} from "@/server/receipts";

export const metadata = { title: "History" };
export const dynamic = "force-dynamic";

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; cursor?: string }>;
}) {
  const { user, workspace } = await requireActiveContext();
  const sp = await searchParams;
  const filter: HistoryFilter = isHistoryFilter(sp.f) ? sp.f : "all";
  const { items, nextCursor } = await listHistory(user.id, workspace.id, filter, sp.cursor);
  return (
    <div className="stack" style={{ ["--gap" as string]: "20px" }}>
      <div>
        <h1>History</h1>
        <p className="muted">
          Every settled request with its receipt. Receipts are never edited; a later correction
          replaces an earlier entry here.
        </p>
      </div>
      <nav aria-label="History filters">
        <ul className="filters plain-list">
          {(Object.keys(HISTORY_FILTERS) as HistoryFilter[]).map((k) => (
            <li key={k}>
              <Link
                href={`/history?f=${k}`}
                className="filter"
                aria-current={k === filter ? "page" : undefined}
              >
                {HISTORY_FILTERS[k].label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {items.length === 0 ? (
        <p className="alert" role="status">
          Nothing here yet. Settled requests and their receipts appear in this list.
        </p>
      ) : (
        <ul className="queue plain-list" aria-label="Settled requests">
          {items.map((r) => (
            <li key={r.receiptId}>
              <Link href={`/history/${r.receiptId}`} className="queue-row">
                <div
                  className="row"
                  style={{ justifyContent: "space-between", flexWrap: "nowrap" }}
                >
                  <strong>{r.summary}</strong>
                  <StatusBadge state={r.finalState} />
                </div>
                <div className="queue-dest mono">{r.destination}</div>
                <div className="muted queue-meta">
                  {r.client}
                  {r.decidedBy ? ` · decided by ${r.decidedBy}` : ""} ·{" "}
                  <RelativeTime iso={r.createdAt.toISOString()} />
                  {r.kind === "correction" ? " · corrected" : ""}
                </div>
                {r.recovery ? (
                  <div className="queue-meta" style={{ marginTop: 6 }}>
                    <strong>{r.recovery.title}.</strong> {r.recovery.recovery}
                  </div>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <Link className="btn btn-sm" href={`/history?f=${filter}&cursor=${nextCursor}`}>
          Load older
        </Link>
      ) : null}
    </div>
  );
}
