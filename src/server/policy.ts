import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalDecisions,
  capabilityPolicies,
  connectorAccounts,
  mcpGrants,
  resourcePolicies,
} from "@/db/schema";
import {
  clampExpiry,
  evaluatePolicy,
  normalizeRuleValue,
  type Effect,
  type PolicyDecision,
  type PolicyFacts,
  type ResourceKind,
  type ResourceRule,
} from "@/approvals/policy";
import { getCapability } from "@/connectors/registry";
import type { Capability } from "@/lib/permissions";
import { recordAudit } from "./audit";
import { loadMembership, requirePermission } from "./authz";
import { WorkspaceError } from "./workspaces";
import type { proposals } from "@/db/schema";

type ProposalRow = typeof proposals.$inferSelect;

async function loadCommon(workspaceId: string, capability: Capability, connectorAccountId: string) {
  const db = getDb();
  const [policy] = await db
    .select()
    .from(capabilityPolicies)
    .where(
      and(
        eq(capabilityPolicies.workspaceId, workspaceId),
        eq(capabilityPolicies.capability, capability),
      ),
    );
  const [connector] = await db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.id, connectorAccountId));
  const rules = await db
    .select()
    .from(resourcePolicies)
    .where(eq(resourcePolicies.workspaceId, workspaceId));
  return {
    capabilityPolicy: policy
      ? {
          enabled: policy.enabled,
          allowSelfApproval: policy.allowSelfApproval,
          expirySeconds: policy.expirySeconds,
        }
      : null,
    connector: connector
      ? {
          id: connector.id,
          status: connector.status,
          grantedScopes: connector.grantedScopes,
          workspaceId: connector.workspaceId,
        }
      : null,
    rules: rules.map((r): ResourceRule => ({
      kind: r.kind,
      value: r.value,
      effect: r.effect,
      connectorAccountId: r.connectorAccountId,
    })),
  };
}

const senderDomainOf = (args: Record<string, unknown>) =>
  typeof args.from === "string" ? args.from.slice(args.from.lastIndexOf("@") + 1) : null;

/** Policy check for creating a proposal from an MCP grant. Args must already be schema-validated. */
export async function evaluateForPropose(input: {
  workspaceId: string;
  capability: Capability;
  connectorAccountId: string;
  args: Record<string, unknown>;
  grantId: string;
}): Promise<PolicyDecision> {
  const def = getCapability(input.capability)!;
  const common = await loadCommon(input.workspaceId, input.capability, input.connectorAccountId);
  const [grant] = await getDb().select().from(mcpGrants).where(eq(mcpGrants.id, input.grantId));
  const actor = grant ? await loadMembership(grant.userId, grant.workspaceId) : null;
  const facts: PolicyFacts = {
    stage: "propose",
    capability: input.capability,
    requiredScopes: def.requiredScopes,
    workspaceId: input.workspaceId,
    resources: def.resources(input.args as never),
    senderDomain: senderDomainOf(input.args),
    grant: grant
      ? { scopes: grant.scopes, revoked: grant.revokedAt !== null, workspaceId: grant.workspaceId }
      : null,
    actor:
      actor && grant
        ? {
            userId: grant.userId,
            role: actor.role,
            approvalCapabilities: actor.approvalCapabilities,
          }
        : null,
    ...common,
  };
  return evaluatePolicy(facts);
}

/** Policy check for a human deciding, or for the executor immediately before dispatch. */
export async function evaluateForProposal(
  stage: "decide" | "execute",
  proposal: ProposalRow,
  args: Record<string, unknown>,
  actorUserId?: string,
): Promise<PolicyDecision> {
  const def = getCapability(proposal.capability)!;
  const common = await loadCommon(
    proposal.workspaceId,
    proposal.capability,
    proposal.connectorAccountId,
  );
  const facts: PolicyFacts = {
    stage,
    capability: proposal.capability,
    requiredScopes: def.requiredScopes,
    workspaceId: proposal.workspaceId,
    resources: def.resources(args as never),
    senderDomain: senderDomainOf(args),
    proposal: {
      initiatedByUserId: proposal.initiatedByUserId,
      expiresAt: proposal.expiresAt,
      state: proposal.state,
    },
    ...common,
  };
  if (stage === "decide" && actorUserId) {
    const m = await loadMembership(actorUserId, proposal.workspaceId);
    facts.actor = m
      ? { userId: actorUserId, role: m.role, approvalCapabilities: m.approvalCapabilities }
      : null;
  }
  if (stage === "execute") {
    const [d] = await getDb()
      .select()
      .from(approvalDecisions)
      .where(
        and(
          eq(approvalDecisions.proposalId, proposal.id),
          eq(approvalDecisions.decision, "approve"),
        ),
      )
      .orderBy(desc(approvalDecisions.createdAt))
      .limit(1);
    const m = d ? await loadMembership(d.decidedByUserId, proposal.workspaceId) : null;
    facts.decider =
      d && m
        ? { userId: d.decidedByUserId, role: m.role, approvalCapabilities: m.approvalCapabilities }
        : null;
  }
  return evaluatePolicy(facts);
}

// ---------- Owner-managed policy settings ----------

export async function listCapabilityPolicies(actorId: string, workspaceId: string) {
  await requirePermission(actorId, workspaceId, "policies.manage");
  return getDb()
    .select()
    .from(capabilityPolicies)
    .where(eq(capabilityPolicies.workspaceId, workspaceId));
}

export async function updateCapabilityPolicy(
  actorId: string,
  workspaceId: string,
  capability: Capability,
  patch: { enabled?: boolean; allowSelfApproval?: boolean; expirySeconds?: number },
) {
  await requirePermission(actorId, workspaceId, "policies.manage");
  const set: Partial<typeof capabilityPolicies.$inferInsert> = { updatedAt: new Date() };
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.allowSelfApproval !== undefined) set.allowSelfApproval = patch.allowSelfApproval;
  if (patch.expirySeconds !== undefined) {
    if (!Number.isInteger(patch.expirySeconds))
      throw new WorkspaceError("invalid", "Expiry must be a whole number of seconds");
    set.expirySeconds = clampExpiry(patch.expirySeconds);
  }
  const rows = await getDb()
    .update(capabilityPolicies)
    .set(set)
    .where(
      and(
        eq(capabilityPolicies.workspaceId, workspaceId),
        eq(capabilityPolicies.capability, capability),
      ),
    )
    .returning();
  if (rows.length === 0) throw new WorkspaceError("not_found", "Policy not found");
  await recordAudit({
    workspaceId,
    actorType: "user",
    actorId,
    action: "policy.capability_updated",
    subjectType: "capability",
    subjectId: capability,
    detail: patch,
  });
  return rows[0]!;
}

export async function listResourceRules(actorId: string, workspaceId: string) {
  await requirePermission(actorId, workspaceId, "policies.manage");
  return getDb()
    .select()
    .from(resourcePolicies)
    .where(eq(resourcePolicies.workspaceId, workspaceId));
}

export async function setResourceRule(
  actorId: string,
  workspaceId: string,
  input: { kind: ResourceKind; value: string; effect: Effect; connectorAccountId?: string | null },
) {
  await requirePermission(actorId, workspaceId, "policies.manage");
  const value = normalizeRuleValue(input.kind, input.value);
  if (!value) throw new WorkspaceError("invalid", "That value is not valid for this kind of rule");
  if (input.effect === "warn" && input.kind !== "email_domain")
    throw new WorkspaceError("invalid", "Only recipient-domain rules can warn");
  if (input.connectorAccountId) {
    const [c] = await getDb()
      .select({ workspaceId: connectorAccounts.workspaceId })
      .from(connectorAccounts)
      .where(eq(connectorAccounts.id, input.connectorAccountId));
    if (!c || c.workspaceId !== workspaceId)
      throw new WorkspaceError("not_found", "Connected account not found");
  }
  const [row] = await getDb()
    .insert(resourcePolicies)
    .values({
      workspaceId,
      kind: input.kind,
      value,
      effect: input.effect,
      connectorAccountId: input.connectorAccountId ?? null,
    })
    .onConflictDoUpdate({
      target: [resourcePolicies.workspaceId, resourcePolicies.kind, resourcePolicies.value],
      set: { effect: input.effect, connectorAccountId: input.connectorAccountId ?? null },
    })
    .returning();
  await recordAudit({
    workspaceId,
    actorType: "user",
    actorId,
    action: "policy.rule_set",
    subjectType: "resource_policy",
    subjectId: row!.id,
    detail: { kind: input.kind, effect: input.effect },
  });
  return row!;
}

export async function removeResourceRule(actorId: string, workspaceId: string, ruleId: string) {
  await requirePermission(actorId, workspaceId, "policies.manage");
  const rows = await getDb()
    .delete(resourcePolicies)
    .where(and(eq(resourcePolicies.id, ruleId), eq(resourcePolicies.workspaceId, workspaceId)))
    .returning({ id: resourcePolicies.id });
  if (rows.length === 0) throw new WorkspaceError("not_found", "Rule not found");
  await recordAudit({
    workspaceId,
    actorType: "user",
    actorId,
    action: "policy.rule_removed",
    subjectType: "resource_policy",
    subjectId: ruleId,
  });
}
