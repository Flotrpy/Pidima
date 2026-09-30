import { setRuleAction } from "@/app/actions/policies";
import { Button } from "@/components/ui";
import { requireActiveContext } from "@/server/active-workspace";
import { listRepoChoices } from "@/server/github-repos";

/** Live, read-only list of repositories the connected account can reach, with one-click rules. */
export async function RepoPicker({ connectorId, name }: { connectorId: string; name: string }) {
  const { user } = await requireActiveContext();
  let data;
  try {
    data = await listRepoChoices(user.id, connectorId);
  } catch {
    return (
      <p className="alert alert-warn" role="status">
        Repositories for {name} could not be listed right now. You can still add rules by name
        above.
      </p>
    );
  }
  return (
    <div className="card stack">
      <h3 style={{ fontSize: "1rem", margin: 0 }}>Repositories reachable by {name}</h3>
      <ul className="plain-list">
        {data.repos.map((r) => (
          <li key={r.fullName} className="row list-row">
            <span className="mono" style={{ flex: 1, minWidth: 180 }}>
              {r.fullName}
            </span>
            <span className="badge badge-neutral">{r.private ? "private" : "public"}</span>
            <span className={`badge ${r.permitted ? "badge-success" : "badge-failure"}`}>
              <span aria-hidden="true">{r.permitted ? "✓" : "⊘"}</span>
              <span>
                {r.permitted
                  ? "Permitted"
                  : r.reason === "resource_blocked"
                    ? "Blocked"
                    : "Not in allowed list"}
              </span>
            </span>
            {(["allow", "block"] as const).map((effect) => (
              <form
                key={effect}
                action={async (fd) => {
                  "use server";
                  await setRuleAction(null, fd);
                }}
              >
                <input type="hidden" name="kind" value="github_repo" />
                <input type="hidden" name="value" value={r.fullName} />
                <input type="hidden" name="effect" value={effect} />
                <input type="hidden" name="connectorAccountId" value={connectorId} />
                <Button
                  type="submit"
                  small
                  variant={effect === "block" ? "danger" : "secondary"}
                  aria-label={`${effect === "allow" ? "Allow" : "Block"} ${r.fullName}`}
                >
                  {effect === "allow" ? "Allow" : "Block"}
                </Button>
              </form>
            ))}
          </li>
        ))}
      </ul>
      {data.hasMore ? (
        <p className="muted">Showing the most recently updated repositories. Add others by name.</p>
      ) : null}
    </div>
  );
}
