"use client";

import { useRef } from "react";

/**
 * Bounded, scrollable preview that always contains the FULL text (nothing is collapsed away),
 * plus an explicit full-content view. Content is rendered strictly as text.
 */
export function LongText({ label, value }: { label: string; value: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const long = value.length > 600 || value.split("\n").length > 14;
  return (
    <div>
      <pre className="longtext" tabIndex={0} aria-label={`${label} (scrollable)`}>
        {value}
      </pre>
      {long ? (
        <>
          <button type="button" className="btn btn-sm" onClick={() => dialog.current?.showModal()}>
            Open full {label.toLowerCase()}
          </button>
          <dialog
            ref={dialog}
            className="fullview"
            aria-label={`Full ${label}`}
            onClick={(e) => e.target === dialog.current && dialog.current?.close()}
          >
            <div className="fullview-panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{label}</strong>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => dialog.current?.close()}
                >
                  Close
                </button>
              </div>
              <pre className="longtext longtext-full" tabIndex={0}>
                {value}
              </pre>
            </div>
          </dialog>
        </>
      ) : null}
    </div>
  );
}
