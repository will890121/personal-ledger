import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function open(): ReturnType<typeof openDatabase> {
  const database = openDatabase(":memory:");
  databases.push(database);
  database.pragma("foreign_keys = ON");
  migrate(database);
  return database;
}

describe("migration 0007", () => {
  it("creates the user keyword table", () => {
    const database = open();

    const columns = (database.pragma("table_info(user_category_keywords)") as { name: string }[])
      .map((column) => column.name)
      .sort();

    expect(columns).toEqual([
      "category_id",
      "created_at",
      "keyword",
      "keyword_id",
      "normalized_keyword",
      "owner_id",
    ]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps one keyword per owner", () => {
    const database = open();
    database
      .prepare(
        "INSERT INTO categories (category_id, owner_id, key, name, kind, depth) VALUES ('c1', 'owner-1', 'expense', '支出', 'expense', 1)",
      )
      .run();
    const insert = database.prepare(
      "INSERT INTO user_category_keywords (keyword_id, owner_id, keyword, normalized_keyword, category_id, created_at) VALUES (?, 'owner-1', ?, ?, 'c1', '2026-09-26T00:00:00.000Z')",
    );
    insert.run("k1", "牛排", "牛排");

    expect(() => insert.run("k2", "牛排", "牛排")).toThrow(/UNIQUE/);
    // 同一個詞在不同帳本之間彼此獨立。
    expect(() =>
      database
        .prepare(
          "INSERT INTO user_category_keywords (keyword_id, owner_id, keyword, normalized_keyword, category_id, created_at) VALUES ('k3', 'owner-2', '牛排', '牛排', 'c1', '2026-09-26T00:00:00.000Z')",
        )
        .run(),
    ).not.toThrow();
  });

  it("registers version 7 and stays idempotent", () => {
    const database = open();
    migrate(database);

    expect(
      (
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
