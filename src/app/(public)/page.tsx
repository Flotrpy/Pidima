import Link from "next/link";
import { Hero } from "@/components/marketing/Hero";
import { InboxDemo } from "@/components/marketing/InboxDemo";
import { Reveal } from "@/components/marketing/Reveal";

export const metadata = { title: "One inbox for every important action your AI wants to take" };

const STEPS = [
  [
    "Propose",
    "Claude prepares an exact action through one secure connection. Nothing happens yet.",
  ],
  [
    "Review",
    "An authorized person sees the destination and the complete content, and can approve, edit or deny.",
  ],
  ["Execute", "Only the approved version runs, once, through the connected account."],
  ["Receipt", "Who decided, what changed and what the provider returned are recorded."],
] as const;

export default function Home() {
  return (
    <>
      <Hero />

      <section className="mk-section" id="product" aria-labelledby="problem-h">
        <div className="container stack" style={{ ["--gap" as string]: "28px" }}>
          <Reveal>
            <h2 id="problem-h" className="mk-h2">
              AI is useful until it acts on its own.
            </h2>
          </Reveal>
          <div className="mk-compare">
            <Reveal>
              <div className="mk-lane mk-lane-bad">
                <h3>Without AI Action Inbox</h3>
                <ol className="mk-flow">
                  <li>AI agent</li>
                  <li>Provider action occurs</li>
                  <li>Team discovers the result later</li>
                </ol>
              </div>
            </Reveal>
            <Reveal delay={0.08}>
              <div className="mk-lane mk-lane-good">
                <h3>With AI Action Inbox</h3>
                <ol className="mk-flow">
                  <li>AI agent</li>
                  <li>Exact proposal</li>
                  <li>Human review</li>
                  <li>Approved execution</li>
                  <li>Receipt</li>
                </ol>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="mk-section mk-alt" id="how-it-works" aria-labelledby="how-h">
        <div className="container stack" style={{ ["--gap" as string]: "28px" }}>
          <Reveal>
            <h2 id="how-h" className="mk-h2">
              How it works
            </h2>
          </Reveal>
          <ol className="mk-steps plain-list">
            {STEPS.map(([t, d], i) => (
              <li key={t}>
                <Reveal delay={i * 0.06}>
                  <div className="mk-step">
                    <span className="mk-step-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <h3>{t}</h3>
                    <p className="muted">{d}</p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="demo-h">
        <div className="container mk-split">
          <Reveal>
            <div className="stack">
              <h2 id="demo-h" className="mk-h2">
                A realistic review, not a summary.
              </h2>
              <p className="muted">
                Every review shows the exact destination and the complete content beside the
                decision. Try the sample: approve it, edit it, or deny it.
              </p>
              <p className="hint">This is a demonstration with sample data. Nothing is sent.</p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <InboxDemo />
          </Reveal>
        </div>
      </section>

      <section className="mk-section mk-alt" id="integrations" aria-labelledby="int-h">
        <div className="container stack" style={{ ["--gap" as string]: "24px" }}>
          <Reveal>
            <h2 id="int-h" className="mk-h2">
              Supported actions in Phase 1
            </h2>
          </Reveal>
          <ul className="mk-grid3 plain-list">
            {[
              [
                "GitHub issue",
                "Propose an issue for a repository you allow. Created once after approval.",
              ],
              [
                "Slack message",
                "Propose a message to a channel the connection already belongs to. You see whether it posts as the app or as a person.",
              ],
              [
                "Email",
                "Propose an email from a connected sender. Recipients, including BCC, are shown prominently. The provider accepting it is recorded, never delivery.",
              ],
            ].map(([t, d]) => (
              <li key={t} className="mk-tile">
                <h3>{t}</h3>
                <p className="muted">{d}</p>
                <span className="badge badge-success">
                  <span aria-hidden="true">✓</span>
                  <span>Available in Phase 1</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            Claude is the supported AI client. Other clients and services are not available yet.
          </p>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="exact-h">
        <div className="container mk-split">
          <Reveal>
            <div className="stack">
              <h2 id="exact-h" className="mk-h2">
                Approval applies to exactly what you reviewed.
              </h2>
              <p className="muted">
                Each proposal version is immutable and bound to its destination, content, connected
                account and requester. Edit it and a new version replaces the old one; an earlier
                approval can never run the new content. Permissions and policy are checked again
                immediately before anything executes.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <ul className="mk-checks plain-list">
              {[
                "Approve one version, not a summary",
                "Edits create a new version and show a diff",
                "Execution happens at most once",
                "Policy re-checked just before dispatch",
                "Unclear provider results are shown as unknown, never as success",
              ].map((t) => (
                <li key={t}>
                  <span aria-hidden="true">✓</span> {t}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <section className="mk-section mk-alt" aria-labelledby="rc-h">
        <div className="container mk-split">
          <Reveal>
            <div className="mk-card" role="group" aria-label="Product preview: sample receipt">
              <div className="mk-card-tag">Product preview · sample data</div>
              <strong>Receipt RCPT-7F3A9C21</strong>
              <dl className="mk-facts">
                <div>
                  <dt>Decision</dt>
                  <dd>Approved by Dev Patel</dd>
                </div>
                <div>
                  <dt>Human edits</dt>
                  <dd>1 (title changed)</dd>
                </div>
                <div>
                  <dt>Provider result</dt>
                  <dd>Issue #418 created</dd>
                </div>
                <div>
                  <dt>Final state</dt>
                  <dd>
                    <span className="badge badge-success">
                      <span aria-hidden="true">✓</span>
                      <span>Completed</span>
                    </span>
                  </dd>
                </div>
              </dl>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="stack">
              <h2 id="rc-h" className="mk-h2">
                Proof of what happened.
              </h2>
              <p className="muted">
                Every settled request produces a receipt: who decided, what was edited, what the
                provider returned and the final state. Receipts are never rewritten; a correction is
                added beside the original. Export as JSON or print.
              </p>
              <p className="hint">
                Receipts are a record kept by the system. They are not a legal or cryptographic
                attestation.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="sec-h">
        <div className="container stack" style={{ ["--gap" as string]: "24px" }}>
          <Reveal>
            <h2 id="sec-h" className="mk-h2">
              Built around least privilege.
            </h2>
          </Reveal>
          <ul className="mk-grid3 plain-list">
            {[
              [
                "Narrow permissions",
                "The AI client can only propose. It has no scope to approve or execute.",
              ],
              [
                "OAuth, separated",
                "Sign-in, provider connections and AI-client access are three separate authorizations.",
              ],
              [
                "Encrypted credentials",
                "Provider tokens are encrypted with authenticated encryption and never reach your browser or the AI client.",
              ],
              [
                "Server-enforced policy",
                "Roles, repositories, channels, senders and recipient domains are checked on the server, every time.",
              ],
              ["Audit history", "Security and action events are recorded with redacted detail."],
              [
                "Revocation",
                "Disconnecting a service or an AI client stops anything not yet executed.",
              ],
            ].map(([t, d]) => (
              <li key={t} className="mk-tile">
                <h3>{t}</h3>
                <p className="muted">{d}</p>
              </li>
            ))}
          </ul>
          <Link href="/security" className="btn" style={{ alignSelf: "flex-start" }}>
            Read how security works
          </Link>
        </div>
      </section>

      <section className="mk-section mk-alt" aria-labelledby="health-h">
        <div className="container mk-split">
          <Reveal>
            <div className="stack">
              <h2 id="health-h" className="mk-h2">
                Connections you can trust to be real.
              </h2>
              <p className="muted">
                Health tests are read-only and show the evidence: credential, reachability,
                identity, granted permissions and destination access. A test never sends a message
                or creates an issue.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <ul
              className="mk-card plain-list"
              aria-label="Product preview: sample connector health"
            >
              <li className="mk-card-tag">Product preview · sample data</li>
              {[
                ["Credential validity", "Passed"],
                ["API reachability", "Passed"],
                ["Connected identity", "Passed"],
                ["Granted permissions", "Passed"],
                ["Last successful test", "2 minutes ago"],
              ].map(([a, b]) => (
                <li key={a} className="row list-row">
                  <span style={{ flex: 1 }}>{a}</span>
                  <span className="badge badge-success">
                    <span aria-hidden="true">✓</span>
                    <span>{b}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <section className="mk-final" aria-labelledby="final-h">
        <div className="container stack" style={{ textAlign: "center", alignItems: "center" }}>
          <h2
            id="final-h"
            className="mk-display"
            style={{ fontSize: "clamp(1.8rem, 4vw, 2.6rem)" }}
          >
            Let AI prepare the work. Keep the final decision.
          </h2>
          <Link href="/sign-in?mode=sign-up" className="btn btn-primary">
            Start Approving Actions
          </Link>
        </div>
      </section>
    </>
  );
}
