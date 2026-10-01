import { RenameForm, CloseForm } from "@/components/team/WorkspaceSettingsForms";
import { Button } from "@/components/ui";
import { signOutAction } from "@/app/actions/auth";
import { requireActiveContext } from "@/server/active-workspace";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, workspace, role } = await requireActiveContext();
  const isOwner = role === "owner";
  return (
    <div className="stack" style={{ ["--gap" as string]: "24px" }}>
      <div>
        <h1>Settings</h1>
        <p className="muted">
          Signed in as {user.email} · {workspace.name} ({role})
        </p>
      </div>
      <section aria-labelledby="ws-h" className="card stack">
        <h2 id="ws-h" style={{ fontSize: "1.1rem" }}>
          Workspace
        </h2>
        {isOwner ? (
          <RenameForm name={workspace.name} />
        ) : (
          <p className="muted">Only owners can rename the workspace.</p>
        )}
      </section>
      <section aria-labelledby="data-h" className="card stack">
        <h2 id="data-h" style={{ fontSize: "1.1rem" }}>
          Your data
        </h2>
        <p>
          Receipts and the activity log are kept as the record of what was approved. Audit events
          are purged after the retention period. See Security and Docs for details.
        </p>
      </section>
      <section aria-labelledby="session-h" className="card stack">
        <h2 id="session-h" style={{ fontSize: "1.1rem" }}>
          Session
        </h2>
        <form action={signOutAction}>
          <Button type="submit">Sign out</Button>
        </form>
      </section>
      {isOwner ? (
        <section aria-labelledby="close-h" className="card stack">
          <h2 id="close-h" style={{ fontSize: "1.1rem" }}>
            Close workspace
          </h2>
          <p>
            Disconnects every connector, revokes all AI client access, and hides the workspace for
            everyone. Receipts and history are retained but no longer reachable. This cannot be
            undone from the app.
          </p>
          <CloseForm name={workspace.name} />
        </section>
      ) : null}
    </div>
  );
}
