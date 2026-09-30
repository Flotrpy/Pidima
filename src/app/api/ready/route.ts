import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { loadKeyring } from "@/server/crypto";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Readiness: configuration is valid, a credential key is loaded, and the database answers.
 * Reports check names only; never connection strings, key material or error detail.
 */
export async function GET() {
  const checks: Record<string, boolean> = { config: false, keys: false, database: false };
  try {
    getEnv();
    checks.config = true;
  } catch {}
  try {
    loadKeyring();
    checks.keys = true;
  } catch {}
  try {
    await getDb().execute(sql`select 1`);
    checks.database = true;
  } catch {}
  const ready = Object.values(checks).every(Boolean);
  return Response.json(
    { status: ready ? "ready" : "unavailable", checks },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
