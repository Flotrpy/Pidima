"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/** Read-only value with a copy button. The value stays selectable if the Clipboard API is blocked. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="field">
      <label htmlFor={`copy-${label}`}>{label}</label>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input
          id={`copy-${label}`}
          className="input mono"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button onClick={copy} aria-describedby={`copy-status-${label}`}>
          Copy
        </Button>
      </div>
      <span id={`copy-status-${label}`} className="hint" role="status">
        {state === "copied"
          ? "Copied."
          : state === "failed"
            ? "Couldn't copy automatically. Select the text and copy it."
            : ""}
      </span>
    </div>
  );
}
