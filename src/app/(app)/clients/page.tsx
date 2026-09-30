import { revokeGrantAction } from "@/app/actions/clients";
import { Button } from "@/components/ui";
import { requireActiveContext } from "@/server/active-workspace";
import { listGrants } from "@/server/mcp-consent";

export const metadata = { title: "AI Clients" };
export const dynamic = "force-dynamic";

const fmt = (d: Date | null) =>
  d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "No activity yet";

export default async function ClientsPage() {
  const { user, workspace } = await requireActiveContext();
  const grants = await listGrants(user.id, workspace.id);
  return (
    <div className="stack" style={{ ["--gap" as string]: "24px" }}>
      <div>
        <h1>AI Clients</h1>
        <p className="muted">
          AI clients authorized to propose actions in {workspace.name}. They can never approve or
          execute.
        </p>
      </div>
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
