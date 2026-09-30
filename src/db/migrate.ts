import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { createDb } from "./client";

export async function runMigrations(connectionString: string) {
  const { db, pool } = createDb(connectionString, 1);
  try {
    await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  runMigrations(url)
    .then(() => console.log("migrations applied"))
    .catch((e) => {
      console.error("migration failed:", e instanceof Error ? e.message : "unknown error");
      process.exit(1);
    });
}
