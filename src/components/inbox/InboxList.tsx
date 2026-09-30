import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { FILTERS, type FilterKey, type InboxRow } from "@/server/inbox";
import { RelativeTime } from "./RelativeTime";

export function InboxList({
  filter,
  counts,
  items,
  nextCursor,
  selectedId,
  q,
}: {
  filter: FilterKey;
  counts: Record<FilterKey, number>;
  items: InboxRow[];
  nextCursor: string | null;
  selectedId?: string;
  q?: string;
}) {
  return (
    <div className="inbox-list stack">
      <form action="/inbox" role="search" className="row" style={{ flexWrap: "nowrap" }}>
        <input type="hidden" name="f" value={filter} />
        <label className="sr-only" htmlFor="inbox-q">
          Search requests
        </label>
        <input
          id="inbox-q"
          name="q"
          type="search"
          className="input"
          placeholder="Search destination, client or person"
          defaultValue={q}
          maxLength={80}
        />
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      <nav aria-label="Inbox filters">
        <ul className="filters plain-list">
          {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
            <li key={k}>
              <Link
                href={`/inbox?f=${k}`}
                className="filter"
                aria-current={k === filter ? "page" : undefined}
              >
                {FILTERS[k].label} <span className="filter-count">{counts[k]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {items.length === 0 ? (
        <p className="alert" role="status">
          {filter === "needs_review"
            ? "You're all caught up. New AI action requests will appear here for review."
            : `Nothing is ${FILTERS[filter].label.toLowerCase()} right now.`}
        </p>
      ) : (
        <ul className="queue plain-list" aria-label={FILTERS[filter].label}>
          {items.map((r) => (
            <li key={r.id}>
              <Link
                href={`/inbox/${r.id}?f=${filter}`}
                className="queue-row"
                aria-current={r.id === selectedId ? "true" : undefined}
              >
                <div
                  className="row"
                  style={{ justifyContent: "space-between", flexWrap: "nowrap" }}
                >
                  <strong>{r.title}</strong>
                  <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    {r.urgent ? (
                      <span className="badge badge-failure">
                        <span aria-hidden="true">⏱</span>
                        <span>Expiring soon</span>
                      </span>
                    ) : null}
                    <StatusBadge state={r.state} />
                  </span>
                </div>
                <div className="queue-dest mono">{r.destination}</div>
                <div className="muted queue-meta">
                  {r.clientLabel}
                  {r.requestedBy ? ` · for ${r.requestedBy}` : ""} ·{" "}
                  <RelativeTime iso={r.createdAt.toISOString()} />
                  {r.state === "PENDING_APPROVAL" ? (
                    <>
                      {" "}
                      · <RelativeTime iso={r.expiresAt.toISOString()} prefix="expires " />
                    </>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <Link
          href={`/inbox?f=${filter}&cursor=${nextCursor}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
          className="btn btn-sm"
        >
          Load older
        </Link>
      ) : null}
    </div>
  );
}
