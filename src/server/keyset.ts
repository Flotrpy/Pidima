import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** Postgres keeps microseconds; JS Dates keep milliseconds. Cursors must carry the exact text. */
export const tsText = (col: AnyColumn) => sql<string>`${col}::text`;

const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Cursor = { t: string; id: string };

export const encodeKeyset = (t: string, id: string) =>
  Buffer.from(JSON.stringify({ t, id })).toString("base64url");

/** Returns null for anything malformed or forged; callers then start from the first page. */
export function decodeKeyset(c: string | undefined): Cursor | null {
  if (!c || c.length > 200) return null;
  try {
    const j = JSON.parse(Buffer.from(c, "base64url").toString());
    return typeof j?.t === "string" && typeof j?.id === "string" && TS.test(j.t) && UUID.test(j.id)
      ? { t: j.t, id: j.id }
      : null;
  } catch {
    return null;
  }
}

export const tsLt = (col: AnyColumn, t: string): SQL => sql`${col} < ${t}::timestamptz`;
export const tsGt = (col: AnyColumn, t: string): SQL => sql`${col} > ${t}::timestamptz`;
export const tsEq = (col: AnyColumn, t: string): SQL => sql`${col} = ${t}::timestamptz`;
