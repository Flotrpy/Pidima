import { revokeGrantAction } from "@/app/actions/clients";
import { Button } from "@/components/ui";
import { requireActiveContext } from "@/server/active-workspace";
import { listGrants } from "@/server/mcp-consent";
import { getClaudeStatus } from "@/server/claude-status";
import { CopyField } from "@/components/clients/CopyField";

export const metadata = { title: "AI Clients" };
export const dynamic = "force-dynamic";

const fmt = (d: Date | null) =>
  d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "No activity yet";

export default async function ClientsPage() {
  const { user, workspace } = await requireActiveContext();
  const grants = await listGrants(user.id, workspace.id);
  const status = await getClaudeStatus(user.id, workspace.id);
  const levels = [
    {
      done: status.gateway.reachable,
      title: "Gateway endpoint reachable",
      detail: status.gateway.detail,
    },
    {
      done: status.authorized.done,
      title: "AI client authorized",
      detail: status.authorized.done
        ? `Authorized: ${status.authorized.clientNames.join(", ")}.`
        : "No AI client has been authorized for this workspace yet.",
    },
    {
      done: status.activityObserved.done,
      title: "Authenticated activity observed",
      detail: status.activityObserved.done
        ? `Last authenticated request: ${fmt(status.activityObserved.lastAt)}.`
        : status.authorized.done
          ? "Claude is authorized, but no authenticated proposal activity has been observed yet."
          : "Nothing to observe until a client is authorized.",
    },
    {
      done: status.proposalReceived.done,
      title: "End-to-end proposal test completed",
      detail: status.proposalReceived.done
        ? `${status.proposalReceived.count} proposal(s) received from an AI client; the latest at ${fmt(status.proposalReceived.lastAt)}.`
        : "No proposal has arrived from an AI client yet.",
    },
  ];
  return (
    <div className="stack" style={{ ["--gap" as string]: "24px" }}>
      <div>
        <h1>AI Clients</h1>
        <p className="muted">
          AI clients authorized to propose actions in {workspace.name}. They can never approve or
          execute.
        </p>
      </div>
      <section className="card stack" aria-labelledby="setup-h">
        <h2 id="setup-h" style={{ fontSize: "1.1rem" }}>
          Connect Claude
        </h2>
        <CopyField label="Remote MCP server URL" value={status.endpointUrl} />
        <ol>
          <li>In Claude, open the connectors settings and choose to add a custom connector.</li>
          <li>
            Paste the URL above. Claude discovers the sign-in details automatically; no API key is
            needed.
          </li>
          <li>
            Sign in here if asked, choose this workspace, and review what the connection allows. It
            can only propose actions.
          </li>
          <li>Enable the connector in a conversation and ask Claude to propose an action.</li>
        </ol>
        <p className="hint">
          Menu names in Claude can change. Refer to Anthropic&apos;s help documentation for the
          current steps.
        </p>
        <p style={{ margin: 0 }}>
          <strong>Safe first test.</strong> Ask Claude:{" "}
          <em>
            &ldquo;Propose a GitHub issue titled &lsquo;AI Action Inbox test&rsquo; in one of my
            repositories.&rdquo;
          </em>{" "}
          It only appears in your inbox; nothing is created until you approve it.
        </p>
      </section>
      <section className="card" aria-labelledby="status-h">
        <h2 id="status-h" style={{ fontSize: "1.1rem" }}>
          Connection status
        </h2>
        <ul className="plain-list">
          {levels.map((l) => (
            <li key={l.title} className="row list-row" style={{ alignItems: "flex-start" }}>
              <span className={`badge ${l.done ? "badge-success" : "badge-neutral"}`}>
                <span aria-hidden="true">{l.done ? "✓" : "–"}</span>
                <span>{l.done ? "Yes" : "Not yet"}</span>
              </span>
              <div style={{ flex: 1, minWidth: 200 }}>
                <strong>{l.title}</strong>
                <div className="muted">{l.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {grants.length === 0 ? (
        <p className="alert" role="status">
          No AI client is authorized yet.
        </p>
      ) : (
        <ul className="card plain-list">
          {grants.map((g) => (
            <li key={g.id} className="row list-row">
              <div style={{ flex: 1, minWidth: 220 }}>
                <strong>{g.clientName}</strong>{" "}
                <span className="muted">authorized by {g.mine ? "you" : g.userName}</span>
                <div className="muted">
                  Can: {g.scopes.join(", ")} · Last activity: {fmt(g.lastActivityAt)}
                </div>
              </div>
              <form action={revokeGrantAction}>
                <input type="hidden" name="grantId" value={g.id} />
                <Button type="submit" small variant="danger">
                  Revoke access
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
