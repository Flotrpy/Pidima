export type DiffLine = { type: "same" | "add" | "del"; text: string };

export type FieldDiff =
  | { key: string; kind: "text"; before: string; after: string; lines: DiffLine[] }
  | {
      key: string;
      kind: "list";
      before: string[];
      after: string[];
      added: string[];
      removed: string[];
    }
  | { key: string; kind: "scalar"; before: string; after: string };

const MAX_LINES = 1500;

/** Line-level LCS diff. Very large inputs fall back to a whole-block replace instead of burning CPU. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i++]! });
    } else {
      out.push({ type: "add", text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ type: "del", text: a[i++]! });
  while (j < b.length) out.push({ type: "add", text: b[j++]! });
  return out;
}

const isMultiline = (s: string) => s.includes("\n") || s.length > 80;

/** Compares two normalized argument objects field by field. Only changed fields are returned. */
export function diffArgs(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldDiff[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: FieldDiff[] = [];
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    if (Array.isArray(b) || Array.isArray(a)) {
      const bl = ((b as unknown[]) ?? []).map(String);
      const al = ((a as unknown[]) ?? []).map(String);
      out.push({
        key,
        kind: "list",
        before: bl,
        after: al,
        added: al.filter((x) => !bl.includes(x)),
        removed: bl.filter((x) => !al.includes(x)),
      });
    } else {
      const bs = b === undefined || b === null ? "" : String(b);
      const as = a === undefined || a === null ? "" : String(a);
      if (isMultiline(bs) || isMultiline(as))
        out.push({ key, kind: "text", before: bs, after: as, lines: diffLines(bs, as) });
      else out.push({ key, kind: "scalar", before: bs, after: as });
    }
  }
  return out;
}
