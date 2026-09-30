export const metadata = { title: "Documentation" };

const SECTIONS: [string, string][] = [
  [
    "Connect Claude",
    "Add the remote MCP server URL shown on the AI Clients page as a custom connector in Claude, sign in, choose a workspace and review what it can do. No API key is needed.",
  ],
  [
    "Connect GitHub, Slack and email",
    "Owners connect accounts from the Connections page. Each connection has a read-only health test. Slack shows whether messages appear from the app or a person; email sends only from the connected address.",
  ],
  [
    "How approval works",
    "Claude proposes an exact action; an authorized person approves, edits or denies it. Approval is bound to the reviewed version and executes at most once.",
  ],
  [
    "Receipts and history",
    "Every settled request has a receipt you can view, print or export as JSON. Corrections are added beside the original.",
  ],
  [
    "Troubleshooting",
    "Failed and unknown outcomes explain what happened and what to do next. An unknown outcome means the provider did not confirm the result: verify at the destination before trying again.",
  ],
  [
    "Security architecture",
    "See the Security page for the controls that are implemented and what is not claimed.",
  ],
];

export default function DocsPage() {
  return (
    <div className="container" style={{ paddingTop: 64, maxWidth: 820 }}>
      <h1 className="mk-display" style={{ fontSize: "clamp(2rem,4vw,2.8rem)" }}>
        Documentation
      </h1>
      <p className="mk-lede">
        Start here. Full technical documentation lives in the project&apos;s <code>docs/</code>{" "}
        folder.
      </p>
      <div className="stack" style={{ ["--gap" as string]: "16px" }}>
        {SECTIONS.map(([t, d]) => (
          <section key={t} className="card">
            <h2 style={{ fontSize: "1.1rem" }}>{t}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {d}
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}
