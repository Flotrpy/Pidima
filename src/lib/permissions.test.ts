import { describe, expect, it } from "vitest";
import { can, canDecide, type Permission, type Role } from "./permissions";

describe("permission matrix", () => {
  it("lets only owners configure the workspace", () => {
    const admin: Permission[] = [
      "workspace.manage",
      "members.manage",
      "connectors.manage",
      "policies.manage",
    ];
    for (const p of admin) {
      expect(can("owner", p)).toBe(true);
      for (const r of ["approver", "member", "viewer"] as Role[]) expect(can(r, p)).toBe(false);
    }
  });

  it("limits deciding to owners and approvers", () => {
    expect(can("owner", "proposals.decide")).toBe(true);
    expect(can("approver", "proposals.decide")).toBe(true);
    expect(can("member", "proposals.decide")).toBe(false);
    expect(can("viewer", "proposals.decide")).toBe(false);
  });

  it("keeps viewers read-only on receipts and activity", () => {
    expect(can("viewer", "receipts.view")).toBe(true);
    expect(can("viewer", "proposals.view")).toBe(false);
    expect(can("viewer", "clients.connect")).toBe(false);
  });

  it("applies a restricted approval scope per proposal type", () => {
    expect(canDecide("approver", null, "email.propose_message")).toBe(true);
    expect(canDecide("approver", ["github.propose_issue"], "github.propose_issue")).toBe(true);
    expect(canDecide("approver", ["github.propose_issue"], "slack.propose_message")).toBe(false);
    expect(canDecide("member", null, "github.propose_issue")).toBe(false);
    expect(canDecide("approver", [], "github.propose_issue")).toBe(false);
  });
});
