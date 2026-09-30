import { acceptInvitationAction } from "@/app/actions/team";
import { Button } from "@/components/ui";

export const metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>Join a workspace</h1>
      <p className="muted">
        Accepting adds you to the workspace with the role you were invited for. You must be signed
        in with the email address that received the invitation.
      </p>
      <form action={acceptInvitationAction}>
        <input type="hidden" name="token" value={token} />
        <Button type="submit" variant="primary">
          Accept invitation
        </Button>
      </form>
    </div>
  );
}
