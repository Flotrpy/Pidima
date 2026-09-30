export type Role = "owner" | "approver" | "member" | "viewer";
export type Capability = "github.propose_issue" | "slack.propose_message" | "email.propose_message";

export const CAPABILITIES: readonly Capability[] = [
  "github.propose_issue",
  "slack.propose_message",
  "email.propose_message",
];
export const isCapability = (v: unknown): v is Capability =>
  typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);

export type Permission =
  | "workspace.manage"
  | "members.manage"
  | "connectors.manage"
  | "policies.manage"
  | "clients.connect"
  | "proposals.view"
  | "proposals.decide"
  | "receipts.view"
  | "activity.view";

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "workspace.manage",
    "members.manage",
    "connectors.manage",
    "policies.manage",
    "clients.connect",
    "proposals.view",
    "proposals.decide",
    "receipts.view",
    "activity.view",
  ]),
  approver: new Set<Permission>([
    "proposals.view",
    "proposals.decide",
    "receipts.view",
    "activity.view",
  ]),
  member: new Set<Permission>([
    "clients.connect",
    "proposals.view",
    "receipts.view",
    "activity.view",
  ]),
  viewer: new Set<Permission>(["receipts.view", "activity.view"]),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

/**
 * Deciding a proposal needs the role permission AND, when the member's approval scope is
 * restricted, that scope must include the proposal's capability.
 */
export function canDecide(
  role: Role,
  approvalCapabilities: readonly Capability[] | null,
  capability: Capability,
): boolean {
  if (!can(role, "proposals.decide")) return false;
  return approvalCapabilities === null || approvalCapabilities.includes(capability);
}

export const NAV_PERMISSION: Record<string, Permission> = {
  "/inbox": "proposals.view",
  "/history": "receipts.view",
  "/connections": "connectors.manage",
  "/clients": "clients.connect",
  "/policies": "policies.manage",
  "/team": "receipts.view",
  "/settings": "workspace.manage",
};
