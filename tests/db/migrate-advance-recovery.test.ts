import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";

function openMemoryDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrate(database);
  return database;
}

describe("migration 0005", () => {
  it("adds the recovery reference column", () => {
    const database = openMemoryDatabase();

    const columns = database.pragma("table_info(allocations)") as { name: string }[];

    expect(columns.map((column) => column.name)).toContain("recovers_allocation_id");
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("registers version 5 and stays idempotent", () => {
    const database = openMemoryDatabase();
    migrate(database);

    expect(
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
  });
});
