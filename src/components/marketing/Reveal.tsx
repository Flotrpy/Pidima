"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Fade-and-rise on first view. The element never changes type and starts fully visible: the hidden
 * starting state is only applied (via data-armed) after hydration, so without JavaScript, or with
 * reduced motion (handled in CSS), all content is simply there.
 */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const rect = el.getBoundingClientRect();
    // Already on screen at load: leave it visible instead of flashing it out and back in.
    if (rect.top < window.innerHeight * 0.9) return;
    el.dataset.armed = "true";
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.dataset.shown = "true";
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -60px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${delay}s` }}>
      {children}
    </div>
  );
}
