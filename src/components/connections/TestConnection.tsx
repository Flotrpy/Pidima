"use client";

import { useActionState } from "react";
import { testConnectionAction, type TestActionState } from "@/app/actions/connectors";
import { Button } from "@/components/ui";

const ICON = { pass: "✓", fail: "✕", skipped: "–" } as const;
const WORD = { pass: "Passed", fail: "Failed", skipped: "Skipped" } as const;

/** Runs a read-only health test and shows each step's real outcome. */
export function TestConnection({ accountId }: { accountId: string }) {
  const [state, action, pending] = useActionState<TestActionState, FormData>(
    testConnectionAction,
    null,
  );
  return (
    <form action={action} className="stack">
      <input type="hidden" name="accountId" value={accountId} />
      <Button type="submit" small disabled={pending} aria-busy={pending}>
        {pending ? "Testing…" : "Test connection"}
      </Button>
      <div aria-live="polite">
        {pending ? (
          <p className="muted">
            Checking credential, reachability, identity and permissions. Nothing is sent or created.
          </p>
        ) : null}
        {state?.ok === false ? <p className="field-error">{state.error}</p> : null}
        {state?.ok ? (
          <ol className="plain-list" aria-label="Test steps">
            {state.result.steps.map((s) => (
              <li key={s.id} className="row" style={{ gap: 8 }}>
                <span
                  className={`badge badge-${s.status === "pass" ? "success" : s.status === "fail" ? "failure" : "neutral"}`}
                >
                  <span aria-hidden="true">{ICON[s.status]}</span>
                  <span>{WORD[s.status]}</span>
                </span>
                <span>{s.label}</span>
                {s.detail ? <span className="muted">{s.detail}</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </form>
  );
}
