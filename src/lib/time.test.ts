import { describe, expect, it } from "vitest";
import { formatRelative, formatUtc, hasHiddenDirectionControls } from "./time";

const now = new Date("2026-01-01T12:00:00Z");

describe("formatRelative", () => {
  it("describes future and past in coarse units", () => {
    expect(formatRelative(new Date(now.getTime() + 27 * 60_000), now)).toBe("in 27 minutes");
    expect(formatRelative(new Date(now.getTime() - 5 * 60_000), now)).toBe("5 minutes ago");
    expect(formatRelative(new Date(now.getTime() + 3 * 3_600_000), now)).toBe("in 3 hours");
    expect(formatRelative(new Date(now.getTime() - 2 * 86_400_000), now)).toBe("2 days ago");
    expect(formatRelative(new Date(now.getTime() + 5_000), now)).toBe("just now");
  });
  it("formats UTC timestamps unambiguously", () => {
    expect(formatUtc("2026-01-01T12:34:56Z")).toBe("2026-01-01 12:34 UTC");
  });
});

describe("hidden direction controls", () => {
  it("flags override characters but not ordinary RTL text", () => {
    expect(hasHiddenDirectionControls("normal", "a‮b")).toBe(true);
    expect(hasHiddenDirectionControls("⁧x")).toBe(true);
    expect(hasHiddenDirectionControls("שלום עולם", "مرحبا")).toBe(false);
  });
});
