import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(connectionString: string, max = 10) {
  const pool = new Pool({ connectionString, max, statement_timeout: 15_000 });
  return { db: drizzle(pool, { schema }), pool };
}

const globalForDb = globalThis as unknown as { __db?: ReturnType<typeof createDb> };

/** Lazily-created process-wide connection pool (survives Next.js dev reloads). */
export function getDb(): Db {
  if (!globalForDb.__db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    globalForDb.__db = createDb(url);
  }
  return globalForDb.__db.db;
}
