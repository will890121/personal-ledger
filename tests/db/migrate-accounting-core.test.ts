import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { seedM1Ledger } from "../fixtures/m1-ledger.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("M2 accounting core migration", () => {
  it("upgrades populated M1 data without losing identity or provenance", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const original = seedM1Ledger(database);

    migrate(database);

    expect(
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(
      database
        .prepare(
          `SELECT t.transaction_id, t.source_event_id, c.key AS category_key
           FROM transactions t
           JOIN allocations a ON a.transaction_id = t.transaction_id
           JOIN categories c ON c.category_id = a.category_id`,
        )
        .get(),
    ).toEqual({
      transaction_id: original.transactionId,
      source_event_id: original.sourceEventId,
      category_key: "expense_dining_lunch",
    });
    expect(
      database
        .prepare("SELECT status, draft_json FROM drafts WHERE draft_id = ?")
        .get("pending-draft"),
    ).toEqual({
      status: "archived",
      draft_json: JSON.stringify({ status: "awaiting_confirmation", note: "preserve me" }),
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent after schema version 2 is recorded", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedM1Ledger(database);
    migrate(database);
    const countsBefore = tableCounts(database);

    migrate(database);

    expect(tableCounts(database)).toEqual(countsBefore);
  });

  it("rolls back schema version 2 when migrated data fails the foreign key check", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    seedM1Ledger(database);
    database.pragma("foreign_keys = OFF");
    database.prepare("UPDATE transactions SET source_event_id = 'missing-event'").run();
    database.pragma("foreign_keys = ON");

    expect(() => {
      migrate(database);
    }).toThrow(/foreign key/i);
    expect(
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'categories'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});

function tableCounts(database: ReturnType<typeof openDatabase>): Record<string, number> {
  const tables = [
    "input_events",
    "drafts",
    "transactions",
    "allocations",
    "categories",
    "audit_events",
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]),
  );
}
