"use client";

import { useActionState } from "react";
import { setRuleAction, type PolicyActionState } from "@/app/actions/policies";
import { Button, TextField } from "@/components/ui";

export function RuleForm({
  kind,
  placeholder,
  hint,
  effects,
  connectors,
}: {
  kind: string;
  placeholder: string;
  hint: string;
  effects: ("allow" | "warn" | "block")[];
  connectors: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<PolicyActionState, FormData>(setRuleAction, null);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="kind" value={kind} />
      <TextField
        id={`rule-${kind}`}
        name="value"
        label="Value"
        placeholder={placeholder}
        hint={hint}
        required
      />
      <div className="row">
        <div className="field">
          <label htmlFor={`effect-${kind}`}>Rule</label>
          <select id={`effect-${kind}`} name="effect" className="select" defaultValue={effects[0]}>
            {effects.map((e) => (
              <option key={e} value={e}>
                {e === "allow" ? "Allow" : e === "warn" ? "Warn" : "Block"}
              </option>
            ))}
          </select>
        </div>
        {connectors.length > 1 ? (
          <div className="field">
            <label htmlFor={`conn-${kind}`}>Applies to</label>
            <select
              id={`conn-${kind}`}
              name="connectorAccountId"
              className="select"
              defaultValue=""
            >
              <option value="">All connected accounts</option>
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="row">
        <Button type="submit" small disabled={pending}>
          {pending ? "Adding…" : "Add rule"}
        </Button>
        <span role="status" className={state && !state.ok ? "field-error" : "muted"}>
          {state?.message}
        </span>
      </div>
    </form>
  );
}
