import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetTestDatabase, testDb } from "./helpers";

const t = testDb();
afterAll(() => t.pool.end());

describe("migrations", () => {
  beforeAll(resetTestDatabase);

  it("applies cleanly and is repeatable", async () => {
    await resetTestDatabase();
    const { rows } = await t.pool.query(
      "select table_name from information_schema.tables where table_schema='public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toContain("users");
  });
});
