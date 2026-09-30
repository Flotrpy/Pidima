import { InviteForm } from "@/components/team/InviteForm";
import { Button } from "@/components/ui";
import { changeRoleAction, removeMemberAction, revokeInvitationAction } from "@/app/actions/team";
import { requireActiveContext } from "@/server/active-workspace";
import { listMembers } from "@/server/workspaces";

export const metadata = { title: "Team" };

export default async function TeamPage() {
  const { user, workspace, role } = await requireActiveContext();
  const { members, invitations } = await listMembers(user.id, workspace.id);
  const isOwner = role === "owner";
  return (
    <div className="stack" style={{ ["--gap" as string]: "24px" }}>
      <div>
        <h1>Team</h1>
        <p className="muted">Members of {workspace.name} and what each role may do.</p>
      </div>
      <section aria-labelledby="members-h" className="card">
        <h2 id="members-h" style={{ fontSize: "1.1rem" }}>
          Members
        </h2>
        <ul className="plain-list">
          {members.map((m) => (
            <li key={m.userId} className="row list-row">
              <div style={{ flex: 1, minWidth: 180 }}>
                <strong>{m.name}</strong> <span className="muted">{m.email}</span>
              </div>
              {isOwner ? (
                <>
                  <form action={changeRoleAction} className="row">
                    <input type="hidden" name="userId" value={m.userId} />
                    <label className="sr-only" htmlFor={`role-${m.userId}`}>
                      Role for {m.name}
                    </label>
                    <select
                      id={`role-${m.userId}`}
                      name="role"
                      className="select"
                      defaultValue={m.role}
                      style={{ width: 140 }}
                    >
                      <option value="owner">Owner</option>
                      <option value="approver">Approver</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <Button type="submit" small>
                      Update role
                    </Button>
                  </form>
                  <form action={removeMemberAction}>
                    <input type="hidden" name="userId" value={m.userId} />
                    <Button type="submit" small variant="danger" aria-label={`Remove ${m.name}`}>
                      Remove
                    </Button>
                  </form>
                </>
              ) : (
                <span className="badge badge-neutral">{m.role}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
      {invitations.length > 0 ? (
        <section aria-labelledby="inv-h" className="card">
          <h2 id="inv-h" style={{ fontSize: "1.1rem" }}>
            Pending invitations
          </h2>
          <ul className="plain-list">
            {invitations.map((i) => (
              <li key={i.id} className="row list-row">
                <span style={{ flex: 1 }}>
                  {i.email} <span className="badge badge-neutral">{i.role}</span>
                </span>
                {isOwner ? (
                  <form action={revokeInvitationAction}>
                    <input type="hidden" name="invitationId" value={i.id} />
                    <Button type="submit" small>
                      Revoke
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {isOwner ? (
        <InviteForm />
      ) : (
        <p className="muted">Only workspace owners can invite or remove members.</p>
      )}
    </div>
  );
}
