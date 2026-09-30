import { redirect } from "next/navigation";
import { dismissOnboardingAction, skipProvidersAction } from "@/app/actions/onboarding";
import { Button, ButtonLink } from "@/components/ui";
import { requireActiveContext } from "@/server/active-workspace";
import { getOnboardingState, type StepId } from "@/server/onboarding";

export const metadata = { title: "Set up your workspace" };

const NEXT_HREF: Record<StepId, string> = {
  workspace: "/onboarding",
  provider: "/connections",
  claude: "/clients",
  test: "/clients",
  review: "/inbox",
};
const STATUS_TEXT = {
  done: "Done",
  skipped: "Skipped",
  current: "In progress",
  todo: "Not started",
} as const;

export default async function OnboardingPage() {
  const { workspace, role } = await requireActiveContext();
  if (role !== "owner") redirect("/inbox");
  const state = await getOnboardingState(workspace.id);

  return (
    <div className="stack" style={{ maxWidth: 720, ["--gap" as string]: "24px" }}>
      <div>
        <h1>Your approval workspace starts here.</h1>
        <p className="muted">
          Connect the services Claude may propose actions for. Nothing is sent or created until an
          authorized person approves the exact request.
        </p>
      </div>
      <ol className="card plain-list" aria-label="Setup steps">
        {state.steps.map((s, i) => (
          <li
            key={s.id}
            className="row list-row"
            aria-current={s.status === "current" ? "step" : undefined}
          >
            <span
              className={`badge ${s.status === "done" ? "badge-success" : s.status === "current" ? "badge-pending" : "badge-neutral"}`}
            >
              <span aria-hidden="true">{s.status === "done" ? "✓" : i + 1}</span>
              <span>{STATUS_TEXT[s.status]}</span>
            </span>
            <span style={{ flex: 1, fontWeight: s.status === "current" ? 650 : 500 }}>
              {s.label}
            </span>
            {s.status === "current" ? (
              <ButtonLink href={NEXT_HREF[s.id]} variant="primary" small>
                Continue
              </ButtonLink>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="row">
        {state.current === "provider" ? (
          <form action={skipProvidersAction}>
            <Button type="submit">Skip providers for now</Button>
          </form>
        ) : null}
        <form action={dismissOnboardingAction}>
          <Button type="submit" variant="ghost">
            Go to my inbox
          </Button>
        </form>
      </div>
    </div>
  );
}
