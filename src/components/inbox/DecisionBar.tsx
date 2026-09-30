"use client";

import Link from "next/link";
import { useActionState, useRef } from "react";
import { decideAction, type DecideState } from "@/app/actions/decide";
import { Button } from "@/components/ui";

const APPROVE_LABEL: Record<string, string> = {
  "github.propose_issue": "Approve and Create",
  "slack.propose_message": "Approve and Send",
  "email.propose_message": "Approve and Send",
};

export function DecisionBar({
  proposalId,
  version,
  capability,
  canDecide,
  canEdit,
  canCancel,
  blockers,
}: {
  proposalId: string;
  version: number;
  capability: string;
  canDecide: boolean;
  canEdit: boolean;
  canCancel: boolean;
  blockers: { code: string; message: string }[];
}) {
  const [state, action, pending] = useActionState<DecideState, FormData>(decideAction, null);
  const denyDialog = useRef<HTMLDialogElement>(null);
  const cannotApprove = blockers.length > 0;

  const hidden = (
    <>
      <input type="hidden" name="proposalId" value={proposalId} />
      <input type="hidden" name="expectedVersion" value={version} />
    </>
  );

  return (
    <div className="decision-bar" role="group" aria-label="Decision">
      {cannotApprove && canDecide ? (
        <ul className="decision-blockers" aria-label="Why you can't approve this">
          {blockers.map((b) => (
            <li key={b.code}>{b.message}</li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        {canDecide ? (
          <form action={action}>
            {hidden}
            <input type="hidden" name="decision" value="approve" />
            <Button type="submit" variant="primary" disabled={pending || cannotApprove}>
              {pending ? "Working…" : (APPROVE_LABEL[capability] ?? "Approve")}
            </Button>
          </form>
        ) : null}
        {canEdit ? (
          <Link href={`/inbox/${proposalId}/edit`} className="btn">
            Edit
          </Link>
        ) : null}
        {canDecide ? (
          <Button
            variant="danger"
            onClick={() => denyDialog.current?.showModal()}
            disabled={pending}
          >
            Deny
          </Button>
        ) : null}
        {canCancel ? (
          <form action={action}>
            {hidden}
            <input type="hidden" name="decision" value="cancel" />
            <Button type="submit" variant="ghost" disabled={pending}>
              Withdraw request
            </Button>
          </form>
        ) : null}
      </div>
      <dialog ref={denyDialog} className="fullview" aria-label="Deny this request">
        <form
          action={(fd) => {
            denyDialog.current?.close();
            action(fd);
          }}
          className="fullview-panel"
        >
          {hidden}
          <input type="hidden" name="decision" value="deny" />
          <strong>Deny this request?</strong>
          <p className="muted" style={{ margin: 0 }}>
            Nothing will be sent or created. You can add a short reason for the record.
          </p>
          <label className="sr-only" htmlFor="deny-reason">
            Reason (optional)
          </label>
          <textarea
            id="deny-reason"
            name="reason"
            className="textarea"
            maxLength={500}
            placeholder="Reason (optional)"
          />
          <div className="row">
            <Button type="submit" variant="danger">
              Deny
            </Button>
            <Button onClick={() => denyDialog.current?.close()}>Keep reviewing</Button>
          </div>
        </form>
      </dialog>
      <div aria-live="polite" role="status">
        {state ? <p className={state.ok ? "alert" : "alert alert-error"}>{state.message}</p> : null}
      </div>
    </div>
  );
}
