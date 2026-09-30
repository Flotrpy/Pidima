"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRef } from "react";
import { PreviewCard } from "./PreviewCard";

const PROVIDERS = ["GitHub", "Slack", "Email"] as const;

/** A dot that travels along a line. Only runs while on screen and never when motion is reduced. */
function Signal({
  axis,
  from,
  to,
  delay,
  color,
}: {
  axis: "y" | "x";
  from: number;
  to: number;
  delay: number;
  color: string;
}) {
  return (
    <motion.span
      aria-hidden="true"
      className="mk-signal"
      style={{ background: color }}
      initial={{ [axis]: from, opacity: 0 }}
      animate={{ [axis]: [from, to], opacity: [0, 1, 1, 0] }}
      transition={{ duration: 2.4, delay, repeat: Infinity, repeatDelay: 1.8, ease: "easeInOut" }}
    />
  );
}

export function Hero() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "0px 0px -20% 0px" });
  const animate = !reduce && inView;

  return (
    <section className="mk-hero" aria-labelledby="hero-h">
      <div className="container mk-hero-grid">
        <div className="mk-hero-copy">
          <p className="mk-eyebrow">For teams using Claude with GitHub, Slack and email</p>
          <h1 id="hero-h" className="mk-display">
            Your AI can prepare the work. You decide what gets done.
          </h1>
          <p className="mk-lede">
            Review important actions from Claude in one trusted inbox. Approve, edit, or deny the
            exact request—and keep a receipt of what happened.
          </p>
          <div className="row" style={{ gap: 12 }}>
            <Link href="/sign-in?mode=sign-up" className="btn btn-primary">
              Start Approving Actions
            </Link>
            <Link href="#how-it-works" className="btn">
              See How It Works
            </Link>
          </div>
          <p className="muted" style={{ marginTop: 16 }}>
            Claude-first. GitHub, Slack, and email in Phase 1.
          </p>
        </div>

        <div
          ref={ref}
          className="mk-network"
          aria-label="Diagram: Claude sends a proposal to the inbox; after a person approves it, the action goes to GitHub, Slack or email."
        >
          <div className="mk-node mk-node-claude">
            <span className="mk-dot" aria-hidden="true" />
            Claude
          </div>
          <div className="mk-line mk-line-v" aria-hidden="true">
            <span className="mk-line-label">proposal</span>
            {animate ? <Signal axis="y" from={0} to={56} delay={0} color="var(--accent)" /> : null}
          </div>
          <div className="mk-center">
            <PreviewCard
              status={
                <span className="badge badge-pending">
                  <span aria-hidden="true">◔</span>
                  <span>Needs review</span>
                </span>
              }
              footer={
                <div className="row" style={{ gap: 8 }} aria-hidden="true">
                  <span className="btn btn-primary btn-sm">Approve and Create</span>
                  <span className="btn btn-sm">Edit</span>
                  <span className="btn btn-sm">Deny</span>
                </div>
              }
            />
            <div className="mk-inbox-pill">AI Action Inbox · Needs review: 3</div>
          </div>
          <div className="mk-line mk-line-v" aria-hidden="true">
            <span className="mk-line-label">approved action</span>
            {animate ? (
              <Signal axis="y" from={0} to={56} delay={1.3} color="var(--success)" />
            ) : null}
          </div>
          <ul className="mk-providers plain-list">
            {PROVIDERS.map((p) => (
              <li key={p} className="mk-node">
                {p}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
