import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

export function seedM1Ledger(database: Database.Database): {
  transactionId: string;
  sourceEventId: string;
} {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  database.exec(
    readFileSync(new URL("../../src/db/migrations/0001_initial.sql", import.meta.url), "utf8"),
  );
  database.prepare("INSERT INTO schema_migrations (version) VALUES (1)").run();

  database
    .prepare(
      `INSERT INTO input_events (
        event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at
      ) VALUES (?, ?, ?, 'telegram', ?, ?, ?)`,
    )
    .run(
      "m1-event",
      "owner-1",
      "m1-update",
      "chat:message",
      "fixture input",
      "2026-09-18T00:00:00.000Z",
    );

  const draft = {
    draftId: "m1-draft",
    ownerId: "owner-1",
    requestId: "m1-request",
    sourceEventId: "m1-event",
    occurredDate: "2026-09-18",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: "m1-allocation",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount: "120", currency: "TWD" },
        category: "餐飲",
        subcategory: "午餐",
      },
    ],
    status: "confirmed",
  };
  database
    .prepare(
      `INSERT INTO drafts (
        draft_id, owner_id, request_id, source_event_id, occurred_date,
        amount, currency, status, draft_json, confirmed_transaction_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      draft.draftId,
      draft.ownerId,
      draft.requestId,
      draft.sourceEventId,
      draft.occurredDate,
      draft.amount.amount,
      draft.amount.currency,
      draft.status,
      JSON.stringify(draft),
      "m1-transaction",
    );
  database
    .prepare(
      `INSERT INTO transactions (
        transaction_id, draft_id, owner_id, request_id, source_event_id,
        occurred_date, amount, currency, status, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
    )
    .run(
      "m1-transaction",
      draft.draftId,
      draft.ownerId,
      draft.requestId,
      draft.sourceEventId,
      draft.occurredDate,
      draft.amount.amount,
      draft.amount.currency,
      "2026-09-18T01:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO allocations (
        allocation_id, transaction_id, funds_effect, purpose,
        amount, currency, category, subcategory
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("m1-allocation", "m1-transaction", "outflow", "expense", "120", "TWD", "餐飲", "午餐");

  database
    .prepare(
      `INSERT INTO input_events (
        event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at
      ) VALUES (?, ?, ?, 'telegram', ?, ?, ?)`,
    )
    .run(
      "pending-event",
      "owner-1",
      "pending-update",
      "chat:pending",
      "pending fixture",
      "2026-09-18T02:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO drafts (
        draft_id, owner_id, request_id, source_event_id, occurred_date,
        amount, currency, status, draft_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?)`,
    )
    .run(
      "pending-draft",
      "owner-1",
      "pending-request",
      "pending-event",
      "2026-09-18",
      "60",
      "TWD",
      JSON.stringify({ status: "awaiting_confirmation", note: "preserve me" }),
    );

  return { transactionId: "m1-transaction", sourceEventId: "m1-event" };
}
