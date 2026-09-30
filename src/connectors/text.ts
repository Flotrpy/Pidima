import { z } from "zod";

/** NFC-normalises, unifies line endings and strips NUL/control characters except \n and \t. */
export function cleanText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export const boundedText = (max: number, opts: { min?: number; multiline?: boolean } = {}) =>
  z
    .string()
    .transform(cleanText)
    .transform((s) => (opts.multiline ? s.trim() : s.replace(/\s+/g, " ").trim()))
    .pipe(
      z
        .string()
        .min(opts.min ?? 1)
        .max(max),
    );
