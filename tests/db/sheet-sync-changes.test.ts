import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";

const OWNER = "owner-1";

// 注意：這個 seed 直接對照 migrations 0001/0002/0003 之後的實際 schema寫，
// 不是憑印象或憑 migration 檔案「應該長怎樣」推測——欄位名稱與 NOT NULL /
// CHECK 限制都以 `.schema` 實際輸出為準。
function seedTransaction(
  database: Database.Database,
  input: {
    id: string;
    updatedAt: string;
    occurredDate?: string;
    status?: string;
    amount?: string;
  },
): void {
  const occurredDate = input.occurredDate ?? "2026-10-01";
  const amount = input.amount ?? "100";
  const status = input.status ?? "confirmed";

  database
    .prepare(
      `INSERT INTO input_events (
         event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at
       ) VALUES (?, ?, ?, 'telegram', '1', 'seed', ?)`,
    )
    .run(`evt-${input.id}`, OWNER, `evt-${input.id}`, input.updatedAt);

  database
    .prepare(
      `INSERT INTO drafts (
         draft_id, owner_id, request_id, source_event_id, occurred_date, status,
         draft_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'archived', '{}', ?, ?)`,
    )
    .run(
      `draft-${input.id}`,
      OWNER,
      `req-${input.id}`,
      `evt-${input.id}`,
      occurredDate,
      input.updatedAt,
      input.updatedAt,
    );

  database
    .prepare(
      `INSERT INTO transactions (
         transaction_id, draft_id, owner_id, request_id, source_event_id, source_type, source_ref,
         occurred_date, amount, currency, status, confirmed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'telegram', '1', ?, ?, 'TWD', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      `draft-${input.id}`,
      OWNER,
      `req-${input.id}`,
      `evt-${input.id}`,
      occurredDate,
      amount,
      status,
      input.updatedAt,
      input.updatedAt,
      input.updatedAt,
    );
}

describe("listChangedTransactions", () => {
  let database: Database.Database;
  let repository: SqliteSheetSyncRepository;

  beforeEach(() => {
    database = new Database(":memory:");
    migrate(database);
    repository = new SqliteSheetSyncRepository(database);

    // categories 在全新資料庫上是空的（migration 0002 只會把「既有交易」種進去，
    // 全新 :memory: 資料庫在套用 migration 當下沒有任何交易）。allocations
    // 測試需要一個現成的 category_id，這裡先補一列。
    database
      .prepare(
        `INSERT INTO categories (category_id, owner_id, key, name, kind, depth, active)
         VALUES ('cat-1', ?, 'expense_dining', '餐飲', 'expense', 1, 1)`,
      )
      .run(OWNER);
  });

  it("returns every transaction when the cursor is null", async () => {
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "t2", updatedAt: "2026-10-01T00:00:01.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });

  it("includes the row sitting exactly on the cursor", async () => {
    // 游標語意是 >= 而不是 >。重寫邊界那一列是冪等的、代價為零；
    // 而用 > 的話，下面那條同毫秒的測試會永久漏掉一筆。
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(
      OWNER,
      { updatedAt: "2026-10-01T00:00:00.000Z", transactionId: "t1" },
      100,
    );

    expect(rows.map((row) => row.transactionId)).toEqual(["t1"]);
  });

  it("does not lose a transaction that shares the cursor's millisecond", async () => {
    // Review Focus #4。t1 與 t2 的 updated_at 完全相同；上一輪在 t1 停下，
    // 游標是 (該毫秒, "t1")。若查詢寫成 updated_at > cursor，t2 會被永遠跳過——
    // 它的 updated_at 不大於游標，而且之後再也不會變。
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "t2", updatedAt: "2026-10-01T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(
      OWNER,
      { updatedAt: "2026-10-01T00:00:00.000Z", transactionId: "t1" },
      100,
    );

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });

  it("orders by (updated_at, transaction_id) so the cursor is well defined", async () => {
    seedTransaction(database, { id: "tb", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "ta", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "tc", updatedAt: "2026-09-30T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows.map((row) => row.transactionId)).toEqual(["tc", "ta", "tb"]);
  });

  it("includes soft-deleted transactions so the mirror can mark them", async () => {
    // 已刪除的交易仍要進鏡像（狀態欄寫已刪除），否則 Sheet 上會留著一列看起來還存在的
    // 交易。查詢若過濾掉 status='deleted'，刪除就永遠不會傳播出去。
    seedTransaction(database, {
      id: "t1",
      updatedAt: "2026-10-01T00:00:00.000Z",
      status: "deleted",
    });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("deleted");
  });

  it("carries each transaction's allocations", async () => {
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    const categoryId = (
      database.prepare("SELECT category_id FROM categories LIMIT 1").get() as
        { category_id: string } | undefined
    )?.category_id;
    expect(categoryId).toBeDefined();
    database
      .prepare(
        `INSERT INTO allocations (
           allocation_id, transaction_id, funds_effect, purpose, amount, currency,
           category_id, category_snapshot, subcategory_snapshot
         ) VALUES ('a1', 't1', 'outflow', 'expense', '100', 'TWD', ?, '餐飲', '午餐')`,
      )
      .run(categoryId);

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows[0]?.allocations).toEqual([
      {
        allocationId: "a1",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: "100",
        categoryName: "餐飲",
        subcategoryName: "午餐",
        counterpartyName: null,
        note: null,
      },
    ]);
  });

  it("respects the limit", async () => {
    seedTransaction(database, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, { id: "t2", updatedAt: "2026-10-01T00:00:01.000Z" });
    seedTransaction(database, { id: "t3", updatedAt: "2026-10-01T00:00:02.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 2);

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });
});
