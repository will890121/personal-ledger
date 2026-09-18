import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapReferenceData } from "../../src/db/bootstrap-reference-data.js";
import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteReferenceRepository } from "../../src/db/sqlite-reference-repository.js";

describe("bootstrapReferenceData", () => {
  let database: Database.Database;
  let repository: SqliteReferenceRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteReferenceRepository(database);
  });

  afterEach(() => database.close());

  it("creates the default TWD account and category tree idempotently", async () => {
    await bootstrapReferenceData(repository, "owner-1");
    const firstCounts = counts(database);

    await bootstrapReferenceData(repository, "owner-1");

    expect(counts(database)).toEqual(firstCounts);
    await expect(
      repository.findCategoryByKey("owner-1", "expense_dining_lunch"),
    ).resolves.toMatchObject({
      name: "午餐",
      depth: 2,
    });
    await expect(repository.findCategoryByKey("owner-1", "income_salary")).resolves.toMatchObject({
      name: "薪資",
      depth: 2,
    });
    await expect(repository.findAccountByName("owner-1", "現金")).resolves.toHaveLength(1);
  });
});

function counts(database: Database.Database): { accounts: number; categories: number } {
  return {
    accounts: (
      database.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number }
    ).count,
    categories: (
      database.prepare("SELECT COUNT(*) AS count FROM categories").get() as { count: number }
    ).count,
  };
}
