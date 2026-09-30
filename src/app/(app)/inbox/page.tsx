import { redirect } from "next/navigation";
import { requireActiveContext } from "@/server/active-workspace";
import { getOnboardingState, landingPath } from "@/server/onboarding";

export const metadata = { title: "Inbox" };

export default async function InboxPage() {
  const { workspace, role } = await requireActiveContext();
  const state = await getOnboardingState(workspace.id);
  if (landingPath(state, role === "owner") === "/onboarding") redirect("/onboarding");
  return (
    <>
      <h1>Inbox</h1>
      <p className="muted">
        You&apos;re all caught up. New AI action requests will appear here for review.
      </p>
    </>
  );
}
