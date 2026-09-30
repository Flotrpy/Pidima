import { describe, expect, it } from "vitest";
import { STATUS_META } from "./status";

describe("status treatments", () => {
  it("gives every state a label and an icon so colour is never the only signal", () => {
    for (const meta of Object.values(STATUS_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.icon.length).toBeGreaterThan(0);
    }
  });

  it("reserves success for completed and keeps unknown distinct", () => {
    const success = Object.entries(STATUS_META).filter(([, m]) => m.tone === "success");
    expect(success.map(([k]) => k)).toEqual(["SUCCEEDED"]);
    expect(STATUS_META.OUTCOME_UNKNOWN.tone).toBe("unknown");
  });
});
