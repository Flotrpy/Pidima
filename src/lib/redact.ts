const SENSITIVE_KEY =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|credential|body|content|message|text|html/i;
const MAX_STRING = 200;
const MAX_DEPTH = 4;

/**
 * Produces a log/audit-safe copy: sensitive-looking keys are replaced, long strings are cut,
 * and depth/array sizes are bounded. Content bodies are never retained.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string")
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}
