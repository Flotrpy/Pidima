"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Item = { href: string; label: string };

/**
 * Uses a native modal <dialog>: the browser provides the focus trap, Escape-to-close and
 * inert background. Scroll is locked via CSS (body:has(dialog[open])).
 */
export function MobileMenu({
  items,
  label = "Menu",
  children,
}: {
  items: readonly Item[];
  label?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onClose = () => setOpen(false);
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, []);

  // The native modal dialog makes the page inert, but Tab can still escape to browser UI.
  // Wrap focus explicitly so keyboard users stay inside the drawer until they close it.
  function trapTab(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== "Tab") return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [],
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  function show() {
    ref.current?.showModal();
    setOpen(true);
  }
  function close() {
    ref.current?.close();
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm menu-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
      >
        {label}
      </button>
      <dialog
        ref={ref}
        className="drawer"
        aria-label="Site navigation"
        onKeyDown={trapTab}
        onClick={(e) => e.target === ref.current && close()}
      >
        <div className="drawer-panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Navigation</strong>
            <button type="button" className="btn btn-sm" onClick={close}>
              Close
            </button>
          </div>
          <nav aria-label="Mobile">
            <ul className="drawer-list">
              {items.map((i) => (
                <li key={i.href}>
                  <Link href={i.href} onClick={close}>
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {children}
        </div>
      </dialog>
    </>
  );
}
