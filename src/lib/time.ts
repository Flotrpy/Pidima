const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "in 27 minutes" / "5 minutes ago". Coarse on purpose: the exact time is always shown alongside. */
export function formatRelative(target: Date | string, now: Date = new Date()): string {
  const t = new Date(target).getTime();
  const diff = t - now.getTime();
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.trunc(diff / ms), unit);
  }
  return Math.abs(diff) < 30_000 ? "just now" : rtf.format(Math.sign(diff), "minute");
}

export const formatUtc = (d: Date | string) =>
  new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";

// Bidirectional override/embedding characters can make text render differently from its logical order.
const BIDI = /[‪-‮⁦-⁩]/;
export const hasHiddenDirectionControls = (...values: string[]) => values.some((v) => BIDI.test(v));
