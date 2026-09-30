import { notFound, redirect } from "next/navigation";
import { EditForm } from "@/components/inbox/EditForm";
import { EDIT_SPECS, argsToForm } from "@/components/inbox/edit-specs";
import { canDecide } from "@/lib/permissions";
import { requireActiveContext } from "@/server/active-workspace";
import { loadMembership } from "@/server/authz";
import { getProposalDetail } from "@/server/inbox";
import { WorkspaceError } from "@/server/workspaces";

export const metadata = { title: "Edit proposal" };
export const dynamic = "force-dynamic";

export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, workspace } = await requireActiveContext();
  const { id } = await params;
  let d;
  try {
    d = await getProposalDetail(user.id, workspace.id, id);
  } catch (e) {
    if (e instanceof WorkspaceError) notFound();
    throw e;
  }
  const m = await loadMembership(user.id, workspace.id);
  if (
    d.state !== "PENDING_APPROVAL" ||
    !m ||
    !canDecide(m.role, m.approvalCapabilities, d.capability as never)
  )
    redirect(`/inbox/${id}`);
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1>Edit before deciding</h1>
      <p className="muted">
        Editing {d.title.toLowerCase()} for <span className="mono">{d.destination}</span>. You are
        changing what will be executed, so the request will be checked against workspace policy
        again.
      </p>
      <EditForm
        proposalId={d.id}
        expectedVersion={d.version}
        fields={EDIT_SPECS[d.capability as keyof typeof EDIT_SPECS]}
        values={argsToForm(d.capability as never, d.args)}
      />
    </div>
  );
}
