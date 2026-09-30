import clsx from "clsx";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

type Base = { id: string; label: string; hint?: string; error?: string };

function Wrap({ id, label, hint, error, children }: Base & { children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const describedBy = (id: string, hint?: string, error?: string) =>
  [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

export function TextField({
  id,
  label,
  hint,
  error,
  className,
  ...rest
}: Base & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        className={clsx("input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </Wrap>
  );
}

export function TextArea({
  id,
  label,
  hint,
  error,
  className,
  ...rest
}: Base & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        className={clsx("textarea", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </Wrap>
  );
}
