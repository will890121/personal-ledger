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
  migrate(database);
  return database;
}

describe("migration 0008", () => {
  it("creates the outbox table", () => {
    const database = open();

    const columns = (database.pragma("table_info(outbox_messages)") as { name: string }[])
      .map((column) => column.name)
      .sort();

    expect(columns).toEqual([
      "attempts",
      "cause",
      "chat_id",
      "created_at",
      "delivered_at",
      "last_error",
      "lease_expires_at",
      "message_id",
      "next_attempt_at",
      "owner_id",
      "reply_markup",
      "status",
      "target_message_id",
      "text",
    ]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects an unknown cause or status", () => {
    const database = open();
    const insert = (cause: string, status: string): void => {
      database
        .prepare(
          `INSERT INTO outbox_messages
             (message_id, owner_id, cause, chat_id, text, status, next_attempt_at)
           VALUES ('m1', 'owner-1', ?, '1', 'hi', ?, '2026-09-30T00:00:00.000Z')`,
        )
        .run(cause, status);
    };

    expect(() => {
      insert("something_else", "pending");
    }).toThrow(/CHECK/);
    expect(() => {
      insert("transaction_confirmed", "queued");
    }).toThrow(/CHECK/);
  });

  it("registers version 8 and stays idempotent", () => {
    const database = open();
    migrate(database);

    expect(
      (
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
