import "server-only";
import { initConnectors } from "@/connectors/init";
import { getRuntime } from "@/connectors/registry";
import type { ProposalValidation } from "@/connectors/types";
import type { Capability } from "@/lib/permissions";
import type { connectorAccounts } from "@/db/schema";
import { runtimeContextFor } from "./connectors";

initConnectors();

/**
 * Asks the provider runtime (read-only) whether a proposal's destination is usable. Any failure to
 * run the check is reported as "unverified" rather than thrown, so a provider outage cannot take
 * proposing down.
 */
export async function validateWithProvider(
  account: typeof connectorAccounts.$inferSelect,
  capability: Capability,
  args: Record<string, unknown>,
): Promise<ProposalValidation> {
  try {
    const runtime = getRuntime(account.provider);
    if (!runtime.validateProposal) return { status: "ok" };
    return await runtime.validateProposal(runtimeContextFor(account), capability, args);
  } catch {
    return { status: "unverified", reason: "validation_unavailable" };
  }
}

export type Resolved =
  { ok: true; args: Record<string, unknown> } | { ok: false; category: string; message: string };

/**
 * Turns friendly references (e.g. Slack "#ops") into canonical IDs, read-only. Must run before
 * policy evaluation so policy sees the real destination. A provider with nothing to resolve passes through.
 */
export async function resolveWithProvider(
  account: typeof connectorAccounts.$inferSelect,
  capability: Capability,
  args: Record<string, unknown>,
): Promise<Resolved> {
  try {
    const runtime = getRuntime(account.provider);
    if (!runtime.resolveArgs) return { ok: true, args };
    const r = await runtime.resolveArgs(runtimeContextFor(account), capability, args);
    return r.status === "rejected"
      ? { ok: false, category: r.category, message: r.message }
      : { ok: true, args: r.args };
  } catch {
    return {
      ok: false,
      category: "provider_unavailable",
      message: "The destination could not be resolved right now.",
    };
  }
}
