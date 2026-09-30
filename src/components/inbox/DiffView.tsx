import { diffArgs, type FieldDiff } from "@/approvals/diff";

const LABELS: Record<string, string> = {
  owner: "Repository owner",
  repo: "Repository",
  title: "Title",
  body: "Body",
  labels: "Labels",
  channel: "Channel",
  text: "Message",
  threadTs: "Thread",
  from: "From",
  to: "To",
  cc: "CC",
  bcc: "BCC",
  subject: "Subject",
  textBody: "Plain-text body",
  htmlBody: "HTML body (source)",
};
const label = (k: string) => LABELS[k] ?? k;

/** Marker characters carry the meaning; colour only reinforces it. */
function Line({ type, text }: { type: "same" | "add" | "del"; text: string }) {
  const mark = type === "add" ? "+" : type === "del" ? "−" : " ";
  const word = type === "add" ? "added" : type === "del" ? "removed" : "unchanged";
  return (
    <div className={`diff-line diff-${type}`}>
      <span className="sr-only">{word}: </span>
      <span aria-hidden="true" className="diff-mark">
        {mark}
      </span>
      <span className="diff-text">{text || " "}</span>
    </div>
  );
}

function Field({ d }: { d: FieldDiff }) {
  return (
    <div className="diff-field">
      <h3 className="diff-h">{label(d.key)}</h3>
      {d.kind === "text" ? (
        <div className="diff-block">
          {d.lines.map((l, i) => (
            <Line key={i} {...l} />
          ))}
        </div>
      ) : d.kind === "list" ? (
        <div className="diff-block">
          {d.removed.map((x) => (
            <Line key={`r${x}`} type="del" text={x} />
          ))}
          {d.added.map((x) => (
            <Line key={`a${x}`} type="add" text={x} />
          ))}
        </div>
      ) : (
        <div className="diff-block">
          <Line type="del" text={d.before || "(empty)"} />
          <Line type="add" text={d.after || "(empty)"} />
        </div>
      )}
    </div>
  );
}

export function DiffView({
  before,
  after,
  editedBy,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  editedBy: string | null;
}) {
  const diffs = diffArgs(before, after);
  return (
    <section aria-labelledby="diff-h" className="stack">
      <h2 id="diff-h" style={{ fontSize: "1rem" }}>
        Changes from the AI&apos;s original proposal{editedBy ? ` (edited by ${editedBy})` : ""}
      </h2>
      {diffs.length === 0 ? (
        <p className="muted">No differences.</p>
      ) : (
        diffs.map((d) => <Field key={d.key} d={d} />)
      )}
    </section>
  );
}
