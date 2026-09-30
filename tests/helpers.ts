import { Pool } from "pg";
import { createDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/action_inbox_test";

/** Drops and recreates the public schema, then applies all migrations. */
export async function resetTestDatabase() {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(
    "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;",
  );
  await admin.end();
  await runMigrations(TEST_DATABASE_URL);
}

export function testDb() {
  return createDb(TEST_DATABASE_URL, 5);
}
