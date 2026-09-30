import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui";
import type { ProposalDetail } from "@/server/inbox";
import { formatUtc } from "@/lib/time";
import { DiffView } from "./DiffView";
import { LongText } from "./LongText";
import { RelativeTime } from "./RelativeTime";

const PENDING_LIKE = new Set(["PENDING_APPROVAL"]);

/** Everything a reviewer must see, in the order they need it. Nothing is hidden behind a toggle. */
export function ReviewPanel({ d, actions }: { d: ProposalDetail; actions?: ReactNode }) {
  return (
    <article
      className="review stack"
      style={{ ["--gap" as string]: "20px" }}
      aria-labelledby="review-h"
    >
      <header className="review-sticky">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 id="review-h" style={{ fontSize: "1.25rem", margin: 0 }}>
            {d.clientLabel} wants to {d.verb}
          </h1>
          <StatusBadge state={d.state} />
        </div>
        <div className="review-dest">
          <span className="label">Where</span>
          <span className="mono review-dest-value">{d.destination}</span>
        </div>
        <div className="muted">
          {PENDING_LIKE.has(d.state) ? (
            <>
              Expires <RelativeTime iso={d.expiresAt.toISOString()} /> ({formatUtc(d.expiresAt)})
            </>
          ) : (
            <>Expires {formatUtc(d.expiresAt)}</>
          )}
          {d.version > 1 ? ` · Version ${d.version} (edited)` : ""}
        </div>
        {actions}
      </header>

      {d.hiddenDirectionWarning ? (
        <p className="alert alert-warn" role="alert">
          This content contains hidden text-direction characters, which can make text display
          differently from how it is stored. Read it carefully.
        </p>
      ) : null}
      {d.warnings.map((w) => (
        <p key={w.code + w.message} className="alert alert-warn" role="alert">
          <strong>Warning:</strong> {w.message}
        </p>
      ))}

      <section aria-labelledby="content-h" className="stack">
        <h2 id="content-h" style={{ fontSize: "1rem" }}>
          Exactly what will be sent
        </h2>
        <dl className="review-fields">
          {d.fields.map((f) => (
            <div
              key={f.label}
              className={f.emphasis ? "review-field review-field-emph" : "review-field"}
            >
              <dt>{f.label}</dt>
              <dd>
                {f.kind === "longtext" ? (
                  <LongText label={f.label} value={f.value as string} />
                ) : Array.isArray(f.value) ? (
                  <ul className="plain-list mono">
                    {f.value.map((v) => (
                      <li key={v} className="isolate">
                        {v}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className={f.emphasis ? "mono isolate" : "isolate"}>{f.value}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {d.version > 1 ? (
        <DiffView
          before={d.originalArgs}
          after={d.args}
          editedBy={
            d.versions.find((v) => v.authorType === "human" && v.version === d.version)
              ?.authorName ?? null
          }
        />
      ) : null}

      <section aria-labelledby="context-h" className="stack">
        <h2 id="context-h" style={{ fontSize: "1rem" }}>
          Who, and through what
        </h2>
        <dl className="facts">
          <dt>Proposed by</dt>
          <dd>{d.clientLabel} (AI client)</dd>
          <dt>On behalf of</dt>
          <dd>{d.requestedBy ?? "Not verified"}</dd>
          <dt>Connected account</dt>
          <dd>
            {d.connector.displayName}{" "}
            <span className="muted">
              ({d.connector.provider}, {d.connector.status})
            </span>
          </dd>
          <dt>Permissions needed</dt>
          <dd>
            {d.requiredScopes.join(", ")}
            <span className="muted">
              {" "}
              · granted: {d.connector.grantedScopes.join(", ") || "none recorded"}
            </span>
          </dd>
          <dt>Requested</dt>
          <dd>{formatUtc(d.createdAt)}</dd>
        </dl>
      </section>

      <section aria-labelledby="conseq-h" className="stack">
        <h2 id="conseq-h" style={{ fontSize: "1rem" }}>
          What will happen
        </h2>
        <ul>
          {d.consequences.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>

      {d.decisions.length > 0 || d.execution ? (
        <section aria-labelledby="hist-h" className="stack">
          <h2 id="hist-h" style={{ fontSize: "1rem" }}>
            History
          </h2>
          <ul className="plain-list">
            {d.decisions.map((x) => (
              <li key={x.at.toISOString() + x.decision}>
                {x.decision} by {x.by} · {formatUtc(x.at)}
                {x.reason ? <span className="muted"> — {x.reason}</span> : null}
              </li>
            ))}
            {d.execution ? (
              <li>
                Execution {d.execution.state.toLowerCase().replace("_", " ")} · started{" "}
                {formatUtc(d.execution.startedAt)}
                {d.execution.finishedAt ? `, finished ${formatUtc(d.execution.finishedAt)}` : ""}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
