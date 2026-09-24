import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";

function openMemoryDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  return database;
}

function seedEvent(database: Database.Database, eventId: string, updateId: string): void {
  database
    .prepare(
      `INSERT INTO input_events (event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at)
       VALUES (?, 'owner-1', ?, 'telegram', '1:1', '午餐 120', '2026-09-20T01:00:00.000Z')`,
    )
    .run(eventId, updateId);
}

describe("migration 0003", () => {
  it("adds conversation state columns while keeping existing drafts", () => {
    const database = openMemoryDatabase();
    migrate(database);

    seedEvent(database, "event-1", "1");
    database
      .prepare(
        `INSERT INTO drafts (draft_id, owner_id, request_id, source_event_id, occurred_date, amount, currency, status, draft_json)
         VALUES ('draft-1', 'owner-1', 'request-1', 'event-1', '2026-09-20', '120', 'TWD', 'awaiting_confirmation', '{}')`,
      )
      .run();

    const draft = database.prepare("SELECT * FROM drafts WHERE draft_id = 'draft-1'").get() as {
      draft_ref: string;
      created_date: string | null;
      batch_id: string | null;
    };

    expect(draft.draft_ref).toMatch(/^[0-9a-f]{8}$/);
    expect(draft.batch_id).toBeNull();
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("allows drafts without an amount", () => {
    const database = openMemoryDatabase();
    migrate(database);
    seedEvent(database, "event-2", "2");
    database
      .prepare(
        `INSERT INTO batches (batch_id, owner_id, source_event_id, item_count, created_at)
         VALUES ('batch-1', 'owner-1', 'event-2', 1, '2026-09-21T01:00:00.000Z')`,
      )
      .run();

    expect(() =>
      database
        .prepare(
          `INSERT INTO drafts (draft_id, draft_ref, owner_id, request_id, source_event_id, batch_id, batch_index, occurred_date, status, pending_fields, draft_json, created_date)
           VALUES ('draft-2', 'aabbccdd', 'owner-1', 'request-2', 'event-2', 'batch-1', 0, '2026-09-21', 'awaiting_input', '[{"field":"amount","candidateIds":[]}]', '{}', '2026-09-21')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("preserves drafts and transactions created before the migration", () => {
    const database = openMemoryDatabase();
    database.pragma("foreign_keys = OFF");
    migrate(database);
    database.pragma("foreign_keys = ON");

    seedEvent(database, "event-3", "3");
    database
      .prepare(
        `INSERT INTO drafts (draft_id, owner_id, request_id, source_event_id, occurred_date, amount, currency, status, draft_json)
         VALUES ('draft-3', 'owner-1', 'request-3', 'event-3', '2026-09-20', '120', 'TWD', 'confirmed', '{}')`,
      )
      .run();

    const kept = database
      .prepare("SELECT status, amount FROM drafts WHERE draft_id = 'draft-3'")
      .get() as { status: string; amount: string };
    expect(kept).toEqual({ status: "confirmed", amount: "120" });
  });

  it("is idempotent across repeated startups", () => {
    const database = openMemoryDatabase();
    migrate(database);
    migrate(database);

    const versions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  });
});
