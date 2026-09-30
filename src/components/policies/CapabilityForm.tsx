"use client";

import { useActionState } from "react";
import { saveCapabilityAction, type PolicyActionState } from "@/app/actions/policies";
import { Button } from "@/components/ui";

const EXPIRY_OPTIONS = [
  [300, "5 minutes"],
  [900, "15 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
  [14400, "4 hours"],
  [43200, "12 hours"],
  [86400, "24 hours"],
  [259200, "3 days"],
  [604800, "7 days"],
] as const;

export function CapabilityForm({
  capability,
  title,
  enabled,
  allowSelfApproval,
  expirySeconds,
  description,
}: {
  capability: string;
  title: string;
  enabled: boolean;
  allowSelfApproval: boolean;
  expirySeconds: number;
  description: string;
}) {
  const [state, action, pending] = useActionState<PolicyActionState, FormData>(
    saveCapabilityAction,
    null,
  );
  const id = capability.replace(/\W/g, "-");
  return (
    <form action={action} className="card stack" aria-labelledby={`cap-${id}`}>
      <input type="hidden" name="capability" value={capability} />
      <div>
        <h3 id={`cap-${id}`} style={{ fontSize: "1.05rem", margin: 0 }}>
          {title}
        </h3>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {description}
        </p>
      </div>
      <label className="row" style={{ gap: 10 }}>
        <input type="checkbox" name="enabled" defaultChecked={enabled} />
        <span>
          <strong>Allow AI clients to propose this</strong>{" "}
          <span className="muted">(off by default)</span>
        </span>
      </label>
      <label className="row" style={{ gap: 10 }}>
        <input type="checkbox" name="allowSelfApproval" defaultChecked={allowSelfApproval} />
        <span>
          Let the requester approve their own proposals{" "}
          <span className="muted">(off keeps a second person in the loop)</span>
        </span>
      </label>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor={`exp-${id}`}>Proposals expire after</label>
        <select
          id={`exp-${id}`}
          name="expirySeconds"
          className="select"
          defaultValue={expirySeconds}
        >
          {EXPIRY_OPTIONS.map(([s, l]) => (
            <option key={s} value={s}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <Button type="submit" variant="primary" small disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <span role="status" className={state && !state.ok ? "field-error" : "muted"}>
          {state?.message}
        </span>
      </div>
    </form>
  );
}
