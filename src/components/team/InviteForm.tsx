"use client";

import { useActionState } from "react";
import { inviteAction, type ActionResult } from "@/app/actions/team";
import { Button, TextField } from "@/components/ui";

export function InviteForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    inviteAction,
    null,
  );
  return (
    <form action={action} className="stack card">
      <h2 style={{ fontSize: "1.1rem" }}>Invite someone</h2>
      <TextField
        id="invite-email"
        name="email"
        type="email"
        label="Email address"
        required
        autoComplete="off"
      />
      <div className="field">
        <label htmlFor="invite-role">Role</label>
        <select id="invite-role" name="role" className="select" defaultValue="member">
          <option value="owner">Owner — manage everything</option>
          <option value="approver">Approver — review and decide actions</option>
          <option value="member">Member — use AI clients, view activity</option>
          <option value="viewer">Viewer — read receipts only</option>
        </select>
      </div>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Inviting…" : "Send invitation"}
      </Button>
      <div aria-live="polite">
        {state?.ok === false ? <p className="field-error">{state.error}</p> : null}
        {state?.ok ? <p className="alert">{state.message}</p> : null}
      </div>
    </form>
  );
}
