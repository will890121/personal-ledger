import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteSummaryRepository } from "../../src/db/sqlite-summary-repository.js";

describe("SqliteSummaryRepository", () => {
  let database: Database.Database;
  let repository: SqliteSummaryRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteSummaryRepository(database);
    database
      .prepare(
        "INSERT INTO categories (category_id, owner_id, key, name, kind, depth) VALUES (?, ?, ?, ?, ?, 1)",
      )
      .run("category-1", "owner-1", "expense_food", "餐飲", "expense");
  });
  afterEach(() => database.close());

  function seed(
    id: string,
    ownerId: string,
    date: string,
    status: "confirmed" | "deleted",
    fundsEffect: string,
    purpose: string,
    amount: string,
  ): void {
    database
      .prepare(
        "INSERT INTO input_events (event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at) VALUES (?, ?, ?, 'telegram', ?, '', ?)",
      )
      .run(`event-${id}`, ownerId, `update-${id}`, id, `${date}T00:00:00.000Z`);
    database
      .prepare(
        "INSERT INTO drafts (draft_id, owner_id, request_id, source_event_id, occurred_date, amount, currency, status, draft_json) VALUES (?, ?, ?, ?, ?, ?, 'TWD', 'confirmed', '{}')",
      )
      .run(`draft-${id}`, ownerId, `request-${id}`, `event-${id}`, date, amount);
    database
      .prepare(
        `INSERT INTO transactions (transaction_id, draft_id, owner_id, request_id, source_event_id, source_type, source_ref, occurred_date, amount, currency, status, confirmed_at, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, 'telegram', ?, ?, ?, 'TWD', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `draft-${id}`,
        ownerId,
        `request-${id}`,
        `event-${id}`,
        id,
        date,
        amount,
        status,
        `${date}T00:00:00.000Z`,
        `${date}T00:00:00.000Z`,
        `${date}T00:00:00.000Z`,
        status === "deleted" ? `${date}T01:00:00.000Z` : null,
      );
    database
      .prepare(
        "INSERT INTO allocations (allocation_id, transaction_id, funds_effect, purpose, amount, currency, category_id, category_snapshot) VALUES (?, ?, ?, ?, ?, 'TWD', 'category-1', '餐飲')",
      )
      .run(`allocation-${id}`, id, fundsEffect, purpose, amount);
  }

  it("uses an inclusive owner-scoped range and excludes deleted rows", async () => {
    seed("start", "owner-1", "2026-09-01", "confirmed", "outflow", "expense", "10");
    seed("end", "owner-1", "2026-09-30", "confirmed", "inflow", "refund", "3");
    seed("internal", "owner-1", "2026-09-15", "confirmed", "internal", "transfer", "50");
    seed("credit", "owner-1", "2026-09-16", "confirmed", "none", "expense", "2");
    seed("deleted", "owner-1", "2026-09-15", "deleted", "outflow", "expense", "500");
    seed("other-owner", "owner-2", "2026-09-15", "confirmed", "outflow", "expense", "900");

    await expect(
      repository.summarize("owner-1", { from: "2026-09-01", to: "2026-09-30" }),
    ).resolves.toMatchObject({
      actualInflow: { amount: "3" },
      actualOutflow: { amount: "10" },
      grossPersonalExpense: { amount: "12" },
      refunds: { amount: "3" },
      netPersonalExpense: { amount: "9" },
      categories: [{ netExpense: { amount: "9" } }],
    });
  });
});
