import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { seedM1Ledger } from "../fixtures/m1-ledger.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("migration 0006", () => {
  it("renames the lunch leaf to 餐飲 without touching its identity", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedM1Ledger(database);

    migrate(database);

    // category_id 刻意不變：allocations.category_id 有外鍵指著它，未確認草稿的
    // draft_json 裡也嵌著同一個 id，改 id 要連帶重寫這些，風險換不到任何好處。
    expect(
      database
        .prepare("SELECT category_id, key, name, depth FROM categories WHERE key = ?")
        .get("expense_dining"),
    ).toEqual({
      category_id: "m2:owner-1:expense_dining_lunch",
      key: "expense_dining",
      name: "餐飲",
      depth: 2,
    });
    expect(
      database.prepare("SELECT 1 FROM categories WHERE key = ?").get("expense_dining_lunch"),
    ).toBeUndefined();
  });

  it("keeps existing allocations pointing at the renamed category", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedM1Ledger(database);

    migrate(database);

    expect(
      database
        .prepare(
          `SELECT c.key AS category_key, a.category_snapshot, a.subcategory_snapshot
           FROM allocations a JOIN categories c ON c.category_id = a.category_id`,
        )
        .get(),
    ).toEqual({
      category_key: "expense_dining",
      // 快照是「當時的樣子」，migration 不得改寫既有交易的歷史紀錄。
      category_snapshot: "餐飲",
      subcategory_snapshot: "午餐",
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("is a no-op on a database that never had the lunch leaf", () => {
    const database = openDatabase(":memory:");
    databases.push(database);

    migrate(database);

    expect(database.prepare("SELECT count(*) AS total FROM categories").get()).toEqual({
      total: 0,
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("registers version 6 and stays idempotent", () => {
    const database = openDatabase(":memory:");
    databases.push(database);

    migrate(database);
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
