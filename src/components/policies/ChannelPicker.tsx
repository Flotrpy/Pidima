import { setRuleAction } from "@/app/actions/policies";
import { Button } from "@/components/ui";
import { requireActiveContext } from "@/server/active-workspace";
import { listChannelChoices } from "@/server/slack-channels";

/** Live, read-only list of channels this connection can post in, with one-click allow/block rules. */
export async function ChannelPicker({ connectorId, name }: { connectorId: string; name: string }) {
  const { user } = await requireActiveContext();
  let data;
  try {
    data = await listChannelChoices(user.id, connectorId);
  } catch {
    return (
      <p className="alert alert-warn" role="status">
        Channels for {name} could not be listed right now. You can still add rules by channel ID
        above.
      </p>
    );
  }
  if (data.channels.length === 0) {
    return (
      <p className="alert" role="status">
        {name} is not a member of any channel yet. Invite it with <code>/invite</code> in the
        channel you want to use.
      </p>
    );
  }
  return (
    <div className="card stack">
      <h3 style={{ fontSize: "1rem", margin: 0 }}>Channels {name} can post in</h3>
      <ul className="plain-list">
        {data.channels.map((c) => (
          <li key={c.id} className="row list-row">
            <span style={{ flex: 1, minWidth: 180 }}>
              <strong>
                {c.isPrivate ? "🔒 " : "#"}
                {c.name}
              </strong>{" "}
              <span className="muted mono">{c.id}</span>
            </span>
            <span className={`badge ${c.permitted ? "badge-success" : "badge-failure"}`}>
              <span aria-hidden="true">{c.permitted ? "✓" : "⊘"}</span>
              <span>
                {c.permitted
                  ? "Permitted"
                  : c.reason === "resource_blocked"
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
                <input type="hidden" name="kind" value="slack_channel" />
                <input type="hidden" name="value" value={c.id} />
                <input type="hidden" name="effect" value={effect} />
                <input type="hidden" name="connectorAccountId" value={connectorId} />
                <Button
                  type="submit"
                  small
                  variant={effect === "block" ? "danger" : "secondary"}
                  aria-label={`${effect === "allow" ? "Allow" : "Block"} #${c.name}`}
                >
                  {effect === "allow" ? "Allow" : "Block"}
                </Button>
              </form>
            ))}
          </li>
        ))}
      </ul>
      {data.truncated ? (
        <p className="muted">Showing the first channels only. Add others by ID.</p>
      ) : null}
    </div>
  );
}
