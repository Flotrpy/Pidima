import "server-only";
import { redact } from "@/lib/redact";

/**
 * Structured, redacted JSON logs. Callers pass identifiers, categories and durations, never
 * content; `redact` is a second line of defence for keys that look sensitive.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...(redact(fields) as object) })}\n`,
  );
}
