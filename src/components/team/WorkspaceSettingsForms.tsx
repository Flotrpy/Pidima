"use client";

import { useActionState } from "react";
import { closeWorkspaceAction, renameWorkspaceAction, type ActionResult } from "@/app/actions/team";
import { Button, TextField } from "@/components/ui";

function Status({ state }: { state: ActionResult | null }) {
  return (
    <div aria-live="polite">
      {state?.ok === false ? <p className="field-error">{state.error}</p> : null}
      {state?.ok ? <p className="alert">{state.message}</p> : null}
    </div>
  );
}

export function RenameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    renameWorkspaceAction,
    null,
  );
  return (
    <form action={action} className="stack">
      <TextField id="ws-name" name="name" label="Workspace name" defaultValue={name} required />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save name"}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function CloseForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    closeWorkspaceAction,
    null,
  );
  return (
    <form action={action} className="stack">
      <TextField
        id="ws-confirm"
        name="confirm"
        label={`Type “${name}” to confirm`}
        autoComplete="off"
        required
      />
      <Button type="submit" variant="danger" disabled={pending}>
        {pending ? "Closing…" : "Close workspace"}
      </Button>
      <Status state={state} />
    </form>
  );
}
