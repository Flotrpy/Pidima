import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` dropped. Two logically
 * equal values always produce identical bytes, so hashes are comparable across processes.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Cannot canonicalize a non-finite number");
    if (value === undefined) return "null";
    return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k.normalize("NFC"))}:${canonicalize(v)}`).join(",")}}`;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export const argsHash = (args: Record<string, unknown>) => sha256Hex(canonicalize(args));

/** Everything an approval is bound to (product spec §5). Changing any field changes the hash. */
export type BindingInput = {
  workspaceId: string;
  capability: string;
  connectorAccountId: string;
  destination: string;
  args: Record<string, unknown>;
  client: { grantId: string | null; label: string };
  expiresAt: Date;
};

export function bindingHash(b: BindingInput): string {
  return sha256Hex(
    canonicalize({
      v: 1,
      workspaceId: b.workspaceId,
      capability: b.capability,
      connectorAccountId: b.connectorAccountId,
      destination: b.destination,
      args: b.args,
      client: b.client,
      expiresAt: b.expiresAt.toISOString(),
    }),
  );
}
