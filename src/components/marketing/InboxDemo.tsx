"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { PreviewCard } from "./PreviewCard";

type Step = "pending" | "executing" | "done" | "denied";

/** Interactive sample of the approval flow. Nothing is sent anywhere; it is a demonstration. */
export function InboxDemo() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState<Step>("pending");
  const [edited, setEdited] = useState(false);
  const title = edited
    ? "Retries dropped after third webhook failure"
    : "Handle failed webhook retries";

  function approve() {
    setStep("executing");
    setTimeout(() => setStep("done"), reduce ? 0 : 900);
  }
  const reset = () => {
    setStep("pending");
    setEdited(false);
  };

  const status =
    step === "pending" ? (
      <span className="badge badge-pending">
        <span aria-hidden="true">◔</span>
        <span>Needs review</span>
      </span>
    ) : step === "executing" ? (
      <span className="badge badge-pending">
        <span aria-hidden="true">↻</span>
        <span>Executing</span>
      </span>
    ) : step === "done" ? (
      <span className="badge badge-success">
        <span aria-hidden="true">✓</span>
        <span>Completed</span>
      </span>
    ) : (
      <span className="badge badge-failure">
        <span aria-hidden="true">⊘</span>
        <span>Denied</span>
      </span>
    );

  return (
    <div className="mk-demo">
      <div aria-live="polite" className="sr-only">
        {step === "pending"
          ? "Request needs review."
          : step === "executing"
            ? "Approved. Executing."
            : step === "done"
              ? "Completed. Receipt created."
              : "Denied. Nothing was created."}
      </div>
      <PreviewCard
        title={title}
        status={status}
        footer={
          step === "pending" ? (
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={approve}>
                Approve and Create
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setEdited((e) => !e)}>
                {edited ? "Undo edit" : "Edit"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => setStep("denied")}
              >
                Deny
              </button>
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={reset}>
                Reset demo
              </button>
            </div>
          )
        }
      />
      <AnimatePresence mode="wait">
        {step === "done" ? (
          <motion.div
            key="r"
            className="mk-receipt"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <strong>Receipt RCPT-7F3A9C21</strong>
            <span>
              Approved by Dev Patel{edited ? " · 1 human edit recorded" : ""} · Issue #418 created ·
              verified by GitHub
            </span>
          </motion.div>
        ) : step === "denied" ? (
          <motion.div
            key="d"
            className="mk-receipt"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <strong>Nothing was created.</strong>
            <span>Denied by Dev Patel · receipt recorded</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
