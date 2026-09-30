import type { Capability } from "@/lib/permissions";
import { emailMessage } from "./capabilities/email-message";
import { githubIssue } from "./capabilities/github-issue";
import { slackMessage } from "./capabilities/slack-message";
import type { CapabilityDefinition, ConnectorMeta, ConnectorRuntime, Provider } from "./types";

// Static definitions live in typed code, not the database.
// Each definition is generic over its own validated argument type; the registry erases that
// at the boundary and callers always re-parse untrusted input with the definition's schema.
const erase = <A extends Record<string, unknown>>(d: CapabilityDefinition<A>) =>
  d as unknown as CapabilityDefinition;
const CAPABILITIES: Record<Capability, CapabilityDefinition> = {
  "github.propose_issue": erase(githubIssue),
  "slack.propose_message": erase(slackMessage),
  "email.propose_message": erase(emailMessage),
};

export const CONNECTORS: Record<Provider, ConnectorMeta> = {
  github: { provider: "github", displayName: "GitHub", capabilities: ["github.propose_issue"] },
  slack: { provider: "slack", displayName: "Slack", capabilities: ["slack.propose_message"] },
  gmail: {
    provider: "gmail",
    displayName: "Email (Gmail)",
    capabilities: ["email.propose_message"],
  },
};

export function getCapability(id: string): CapabilityDefinition | null {
  return Object.hasOwn(CAPABILITIES, id)
    ? (CAPABILITIES[id as Capability] as unknown as CapabilityDefinition)
    : null;
}

export function allCapabilities(): CapabilityDefinition[] {
  return Object.values(CAPABILITIES);
}

export function providerOf(capability: Capability): Provider {
  return CAPABILITIES[capability].provider;
}

const runtimes = new Map<Provider, ConnectorRuntime>();

export function registerRuntime(runtime: ConnectorRuntime) {
  runtimes.set(runtime.provider, runtime);
}

/** Provider I/O is only reachable through this lookup, so unregistered providers fail closed. */
export function getRuntime(provider: Provider): ConnectorRuntime {
  const r = runtimes.get(provider);
  if (!r) throw new Error(`No runtime registered for provider ${provider}`);
  return r;
}
