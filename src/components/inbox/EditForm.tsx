"use client";

import Link from "next/link";
import { useActionState } from "react";
import { editProposalAction, type EditState } from "@/app/actions/edit";
import { Button, TextArea, TextField } from "@/components/ui";
import type { EditField } from "./edit-specs";

export function EditForm({
  proposalId,
  expectedVersion,
  fields,
  values,
}: {
  proposalId: string;
  expectedVersion: number;
  fields: EditField[];
  values: Record<string, string>;
}) {
  const [state, action, pending] = useActionState<EditState, FormData>(editProposalAction, null);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      {fields.map((f) =>
        f.kind === "text" ? (
          <TextField
            key={f.name}
            id={f.name}
            name={f.name}
            label={f.label}
            hint={f.hint}
            defaultValue={values[f.name]}
            error={state?.fieldErrors[f.name]}
          />
        ) : (
          <TextArea
            key={f.name}
            id={f.name}
            name={f.name}
            label={f.label}
            hint={f.hint}
            defaultValue={values[f.name]}
            error={state?.fieldErrors[f.name]}
            rows={f.kind === "lines" ? 3 : 10}
          />
        ),
      )}
      <TextField
        id="reason"
        name="reason"
        label="Reason for the change (optional)"
        hint="Recorded on the receipt."
      />
      <div aria-live="polite">
        {state?.error ? (
          <p className="alert alert-error" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
      <div className="row">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Save as new version"}
        </Button>
        <Link href={`/inbox/${proposalId}`} className="btn">
          Cancel
        </Link>
      </div>
      <p className="hint">
        Saving creates a new version for review. The AI&apos;s original stays on record, and nothing
        is sent until someone approves.
      </p>
    </form>
  );
}
