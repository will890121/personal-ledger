import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapReferenceData } from "../../src/db/bootstrap-reference-data.js";
import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteReferenceRepository } from "../../src/db/sqlite-reference-repository.js";
import { seedM1Ledger } from "../fixtures/m1-ledger.js";

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
    await expect(repository.findCategoryByKey("owner-1", "expense_dining")).resolves.toMatchObject({
      name: "餐飲",
      depth: 2,
    });
    await expect(repository.findCategoryByKey("owner-1", "income_salary")).resolves.toMatchObject({
      name: "薪資",
      depth: 2,
    });
    await expect(repository.findAccountByName("owner-1", "現金")).resolves.toHaveLength(1);
  });
  it("reuses the category a migration already created under the same key", async () => {
    // M1 升級路徑：migration 0002 以 id 'm2:<owner>:expense_dining_lunch' 建立餐飲葉分類，
    // 0006 只改它的 key 與 name。bootstrap 隨後想用 id 'm2:<owner>:expense_dining' 建立
    // 同一個 key，若按 id 判斷衝突就會踩到 UNIQUE (owner_id, key) 而整個啟動失敗。
    // key 才是分類的邏輯身分，id 是不透明識別碼。
    const upgraded = openDatabase(":memory:");
    try {
      seedM1Ledger(upgraded);
      migrate(upgraded);

      await bootstrapReferenceData(new SqliteReferenceRepository(upgraded), "owner-1");

      expect(
        upgraded
          .prepare("SELECT category_id, name FROM categories WHERE owner_id = ? AND key = ?")
          .all("owner-1", "expense_dining"),
      ).toEqual([{ category_id: "m2:owner-1:expense_dining_lunch", name: "餐飲" }]);
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
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
