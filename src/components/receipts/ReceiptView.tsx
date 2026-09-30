import Link from "next/link";
import { DiffView } from "@/components/inbox/DiffView";
import { StatusBadge } from "@/components/ui";
import { formatUtc } from "@/lib/time";
import type { ReceiptBody } from "@/server/receipts";

const who = (p: { name: string } | null) => p?.name ?? "Not verified";
const OUTCOME: Record<string, string> = {
  approved: "Approved",
  denied: "Denied",
  canceled: "Canceled",
  expired: "Expired without a decision",
  none: "No decision",
};

/** One receipt, rendered for people. Presentation only: every value comes from the stored, sanitized body. */
export function ReceiptView({
  body,
  linked,
}: {
  body: ReceiptBody;
  linked?: { id: string; number: string; kind: string }[];
}) {
  const ex = body.execution;
  return (
    <article
      className="receipt stack"
      aria-labelledby="receipt-h"
      style={{ ["--gap" as string]: "18px" }}
    >
      <header className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 id="receipt-h" style={{ fontSize: "1.3rem", margin: 0 }}>
            Receipt {body.receiptNumber}
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            {body.kind === "correction" ? `Correction of ${body.correctsReceiptNumber} · ` : ""}
            Generated {formatUtc(body.generatedAt)} · {body.workspace.name}
          </p>
        </div>
        <StatusBadge state={body.finalState} />
      </header>

      {linked && linked.length > 1 ? (
        <nav aria-label="Related receipts" className="alert">
          This action has {linked.length} receipts (the original is never altered; corrections are
          added):{" "}
          {linked.map((l, i) => (
            <span key={l.id}>
              {i > 0 ? " · " : ""}
              <Link href={`/history/${l.id}`}>
                {l.number} ({l.kind})
              </Link>
            </span>
          ))}
        </nav>
      ) : null}

      <section aria-labelledby="r-what" className="stack">
        <h2 id="r-what" style={{ fontSize: "1rem" }}>
          What was requested
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{body.action.summary}</strong>
        </p>
        <dl className="facts">
          {body.action.facts.map((f) => (
            <div key={f.label} style={{ display: "contents" }}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
          <dt>Destination</dt>
          <dd className="mono">{body.action.destination}</dd>
          <dt>Connected account</dt>
          <dd>
            {body.connector
              ? `${body.connector.displayName} (${body.connector.provider})`
              : "Removed"}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="r-who" className="stack">
        <h2 id="r-who" style={{ fontSize: "1rem" }}>
          Who and when
        </h2>
        <dl className="facts">
          <dt>Proposed by</dt>
          <dd>{body.client.label} (AI client)</dd>
          <dt>On behalf of</dt>
          <dd>{who(body.initiatedBy)}</dd>
          <dt>Decision</dt>
          <dd>
            {OUTCOME[body.decision.outcome]}
            {body.decision.by ? ` by ${body.decision.by.name}` : ""}
            {body.decision.at ? ` · ${formatUtc(body.decision.at)}` : ""}
          </dd>
          {body.decision.reason ? (
            <>
              <dt>Reason</dt>
              <dd>{body.decision.reason}</dd>
            </>
          ) : null}
          <dt>Requested</dt>
          <dd>{formatUtc(body.proposal.createdAt)}</dd>
        </dl>
      </section>

      {body.humanEdits.count > 0 ? (
        <section aria-labelledby="r-edits" className="stack">
          <h2 id="r-edits" style={{ fontSize: "1rem" }}>
            Human edits ({body.humanEdits.count})
          </h2>
          <ul>
            {body.humanEdits.versions.map((v) => (
              <li key={v.version}>
                Version {v.version} by {who(v.by)} · {formatUtc(v.at)}
                {v.reason ? ` — ${v.reason}` : ""}
              </li>
            ))}
          </ul>
          <DiffView
            before={Object.fromEntries(
              body.humanEdits.diff.map((d) => [d.key, d.kind === "list" ? d.before : d.before]),
            )}
            after={Object.fromEntries(
              body.humanEdits.diff.map((d) => [d.key, d.kind === "list" ? d.after : d.after]),
            )}
            editedBy={null}
          />
        </section>
      ) : null}

      <section aria-labelledby="r-exec" className="stack">
        <h2 id="r-exec" style={{ fontSize: "1rem" }}>
          What happened
        </h2>
        {!ex ? (
          <p>Nothing was sent or created.</p>
        ) : (
          <>
            <dl className="facts">
              <dt>Execution</dt>
              <dd>
                {ex.state.replace("_", " ").toLowerCase()} · {ex.attempts} attempt
                {ex.attempts === 1 ? "" : "s"}
              </dd>
              <dt>Started</dt>
              <dd>{formatUtc(ex.startedAt)}</dd>
              {ex.finishedAt ? (
                <>
                  <dt>Finished</dt>
                  <dd>{formatUtc(ex.finishedAt)}</dd>
                </>
              ) : null}
              {ex.result?.url ? (
                <>
                  <dt>Result</dt>
                  <dd>
                    <a href={ex.result.url} rel="noopener noreferrer">
                      {ex.result.url}
                    </a>
                  </dd>
                </>
              ) : ex.result?.providerId ? (
                <>
                  <dt>Provider reference</dt>
                  <dd className="mono">{ex.result.providerId}</dd>
                </>
              ) : null}
              {ex.result?.note ? (
                <>
                  <dt>What this proves</dt>
                  <dd>{ex.result.note}</dd>
                </>
              ) : null}
            </dl>
            {ex.error ? (
              <p
                className={
                  body.finalState === "OUTCOME_UNKNOWN" ? "alert alert-warn" : "alert alert-error"
                }
              >
                <strong>{ex.error.title}.</strong> {ex.error.recovery}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="r-hash" className="stack">
        <h2 id="r-hash" style={{ fontSize: "1rem" }}>
          Integrity references
        </h2>
        <dl className="facts">
          <dt>Original proposal hash</dt>
          <dd className="mono">{body.hashes.originalProposal}</dd>
          <dt>Approved content hash</dt>
          <dd className="mono">{body.hashes.approvedContent}</dd>
          <dt>Binding hash</dt>
          <dd className="mono">{body.hashes.binding}</dd>
          <dt>Correlation ID</dt>
          <dd className="mono">{body.proposal.correlationId}</dd>
        </dl>
        <p className="hint">
          Hashes identify the exact content. They are a record kept by this system, not a legal or
          cryptographic attestation.
        </p>
      </section>
    </article>
  );
}
