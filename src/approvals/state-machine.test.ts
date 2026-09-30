import { describe, expect, it } from "vitest";
import {
  ALL_EVENTS,
  ALL_STATES,
  InvalidTransitionError,
  allowedPairs,
  canTransition,
  isTerminal,
  nextState,
} from "./state-machine";

describe("proposal state machine", () => {
  it("follows the specified happy path", () => {
    let s = nextState("DRAFT", "submit");
    expect(s).toBe("PENDING_APPROVAL");
    s = nextState(s, "approve");
    s = nextState(s, "claim");
    expect(s).toBe("EXECUTING");
    expect(nextState(s, "succeed")).toBe("SUCCEEDED");
    expect(nextState("EXECUTING", "fail")).toBe("FAILED");
    expect(nextState("EXECUTING", "mark_unknown")).toBe("OUTCOME_UNKNOWN");
  });

  it("supports edit (new version), deny, cancel and timeout from pending", () => {
    // An edit appends a new version; the proposal itself stays pending.
    expect(nextState("PENDING_APPROVAL", "edit")).toBe("PENDING_APPROVAL");
    expect(nextState("PENDING_APPROVAL", "deny")).toBe("DENIED");
    expect(nextState("PENDING_APPROVAL", "cancel")).toBe("CANCELED");
    expect(nextState("PENDING_APPROVAL", "expire")).toBe("EXPIRED");
  });

  it("only resolves an unknown outcome through reconciliation", () => {
    expect(nextState("OUTCOME_UNKNOWN", "reconcile_success")).toBe("SUCCEEDED");
    expect(nextState("OUTCOME_UNKNOWN", "reconcile_failure")).toBe("FAILED");
    for (const e of ALL_EVENTS.filter((e) => !e.startsWith("reconcile"))) {
      expect(canTransition("OUTCOME_UNKNOWN", e)).toBe(false);
    }
  });

  it("makes denial, expiry, cancellation, supersession and final results terminal", () => {
    for (const s of [
      "DENIED",
      "EXPIRED",
      "CANCELED",
      "SUPERSEDED",
      "SUCCEEDED",
      "FAILED",
    ] as const) {
      expect(isTerminal(s)).toBe(true);
      for (const e of ALL_EVENTS) expect(canTransition(s, e)).toBe(false);
    }
    expect(isTerminal("OUTCOME_UNKNOWN")).toBe(false);
  });

  it("never edits anything that is no longer pending", () => {
    for (const s of ALL_STATES.filter((s) => s !== "PENDING_APPROVAL"))
      expect(canTransition(s, "edit")).toBe(false);
  });

  it("cannot execute anything that has not been approved, and cannot cancel once executing", () => {
    for (const s of ALL_STATES.filter((s) => s !== "APPROVED"))
      expect(canTransition(s, "claim")).toBe(false);
    expect(canTransition("EXECUTING", "cancel")).toBe(false);
    expect(canTransition("SUCCEEDED", "cancel")).toBe(false);
    expect(canTransition("PENDING_APPROVAL", "claim")).toBe(false);
    expect(canTransition("APPROVED", "approve")).toBe(false);
  });

  it("rejects every transition that is not in the table with a typed error", () => {
    const allowed = new Set(allowedPairs().map(([a, b]) => `${a}>${b}`));
    let rejected = 0;
    for (const from of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (canTransition(from, event)) {
          expect(allowed.has(`${from}>${nextState(from, event)}`)).toBe(true);
        } else {
          expect(() => nextState(from, event)).toThrow(InvalidTransitionError);
          rejected++;
        }
      }
    }
    expect(rejected).toBeGreaterThan(80);
  });
});
