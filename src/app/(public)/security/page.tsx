export const metadata = {
  title: "Security",
  description: "How AI Action Inbox limits, records and verifies what AI clients can do.",
};

const ITEMS: [string, string][] = [
  [
    "Least privilege",
    "AI clients receive proposal tools only. The scopes they can hold are “propose” and “read status”; there is no scope that approves or executes. Provider connections request the narrowest permissions that work (for example, GitHub public-only access is offered, and email uses send-only access that cannot read mail).",
  ],
  [
    "Separate authorizations",
    "Signing in to AI Action Inbox, connecting GitHub, Slack or email, and authorizing an AI client are three independent grants. Each is bound to a user and a workspace, uses short-lived single-use state, and supports PKCE where applicable.",
  ],
  [
    "Encrypted credential storage",
    "Provider credentials are encrypted with AES-256-GCM using versioned keys held outside the database, bound to their owning connection. They are never sent to the browser or to an AI client, and are not written to logs.",
  ],
  [
    "Exact-action approval",
    "An approval names one immutable version of one proposal, bound to its destination, content, connected account, requester and expiry. Editing creates a new version. Content is hashed and verified again before execution.",
  ],
  [
    "Execution coordination",
    "A database-enforced claim allows a proposal version to execute at most once, even with concurrent requests or several servers. Ambiguous provider results are recorded as “outcome unknown” and are never retried automatically.",
  ],
  [
    "Connector isolation",
    "Provider traffic goes only to fixed provider addresses, with timeouts, size limits and no redirect following. Connection tests are read-only.",
  ],
  [
    "Server-enforced policy",
    "Roles, enabled actions, repositories, channels, senders and recipient domains are evaluated on the server when a proposal is created, when it is decided and immediately before execution. Everything is denied until enabled.",
  ],
  [
    "Redacted logs and audit history",
    "Structured logs and audit events record identifiers and outcomes, not message bodies or credentials.",
  ],
  [
    "Revocation",
    "Disconnecting a provider deletes its credentials and stops unexecuted proposals. Revoking an AI client invalidates its tokens.",
  ],
];

export default function SecurityPage() {
  return (
    <div className="container" style={{ paddingTop: 64, maxWidth: 820 }}>
      <h1 className="mk-display" style={{ fontSize: "clamp(2rem,4vw,2.8rem)" }}>
        Security
      </h1>
      <p className="mk-lede">What is implemented today, stated plainly.</p>
      <div className="stack" style={{ ["--gap" as string]: "20px" }}>
        {ITEMS.map(([t, d]) => (
          <section key={t} className="card" aria-labelledby={`s-${t.replace(/\W/g, "")}`}>
            <h2 id={`s-${t.replace(/\W/g, "")}`} style={{ fontSize: "1.1rem" }}>
              {t}
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              {d}
            </p>
          </section>
        ))}
      </div>
      <h2 style={{ marginTop: 32 }}>What we do not claim</h2>
      <p className="muted">
        No certification, compliance attestation or independent audit is claimed. Receipts are
        records kept by the system, not legally binding or cryptographically non-repudiable. No
        system can guarantee that an AI will never propose something harmful: the design goal is
        that a person sees and decides every action first.
      </p>
    </div>
  );
}
