import Link from "next/link";
import type { OperationalSummary } from "@/server/inbox";
import { formatRelative } from "@/lib/time";

/** Compact operational summary: what needs me, what is in flight, what is broken. */
export function SummaryStrip({ s }: { s: OperationalSummary }) {
  const item = (
    label: string,
    value: number,
    href: string,
    tone: "pending" | "failure" | "unknown" | "neutral",
  ) => (
    <li key={label}>
      <Link href={href} className={`summary-item summary-${value > 0 ? tone : "neutral"}`}>
        <span className="summary-n">{value}</span>
        <span>{label}</span>
      </Link>
    </li>
  );
  return (
    <section aria-label="Operational summary">
      <ul className="summary plain-list">
        {item("Needs review", s.needsReview, "/inbox?f=needs_review", "pending")}
        {item("Executing", s.executing, "/inbox?f=executing", "pending")}
        {item("Failed", s.failed, "/inbox?f=failed", "failure")}
        {item("Outcome unknown", s.outcomeUnknown, "/inbox?f=unknown", "unknown")}
        {item("Connector problems", s.connectorProblems, "/connections", "failure")}
      </ul>
      <p className="muted summary-foot">
        {s.expiringSoon > 0 ? <strong>{s.expiringSoon} expiring within 15 minutes. </strong> : null}
        Last verified activity:{" "}
        {s.lastVerifiedActivity ? formatRelative(s.lastVerifiedActivity) : "none yet"}.
      </p>
    </section>
  );
}
