import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";
import { seedTransaction } from "../fixtures/sheet-sync-seed.js";

const OWNER = "owner-1";

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
    seedTransaction(database, OWNER, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "t2", updatedAt: "2026-10-01T00:00:01.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });

  it("excludes the row sitting exactly on the cursor", async () => {
    // 游標那一列在上一輪已經同步完了，游標就是停在它身上。再撈一次不是「冪等地
    // 重寫、代價為零」——它會讓系統永遠靜不下來：沒有任何新變更時，每一輪都還是
    // 撈到這一列、還是打四次 Sheets API、還是把摘要的更新時間重寫一遍。
    seedTransaction(database, OWNER, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(
      OWNER,
      { updatedAt: "2026-10-01T00:00:00.000Z", transactionId: "t1" },
      100,
    );

    expect(rows.map((row) => row.transactionId)).toEqual([]);
  });

  it("does not lose a transaction that shares the cursor's millisecond", async () => {
    // Review Focus #4。t1 與 t2 的 updated_at 完全相同；上一輪在 t1 停下，
    // 游標是 (該毫秒, "t1")。t2 不能被跳過——若外層那一半的比較寫成只看
    // updated_at（沒有 transaction_id 的 tie-break），t2 的時間不大於游標，
    // 就會永遠撈不到，而且它的 updated_at 之後再也不會變。
    seedTransaction(database, OWNER, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "t2", updatedAt: "2026-10-01T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(
      OWNER,
      { updatedAt: "2026-10-01T00:00:00.000Z", transactionId: "t1" },
      100,
    );

    expect(rows.map((row) => row.transactionId)).toEqual(["t2"]);
  });

  it("does not re-deliver a transaction sorting before the cursor within the same millisecond", async () => {
    // Review Focus #4 的另一半：t0 < t1 < t2 共用同一個 updated_at 毫秒值，
    // 上一輪在 t1 停下，游標是 (該毫秒, "t1")。外層比較若誤寫成
    // updated_at >= cursor，整個 OR 分支會被 updated_at 這一半吃掉——退化成
    // 純粹的 updated_at >= cursor，t0 因為時間相同而被重新撈出，且每一輪都會
    // 再撈一次，永遠重工。正確結果是只留排在游標之後的 t2。
    seedTransaction(database, OWNER, { id: "t0", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "t2", updatedAt: "2026-10-01T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(
      OWNER,
      { updatedAt: "2026-10-01T00:00:00.000Z", transactionId: "t1" },
      100,
    );

    expect(rows.map((row) => row.transactionId)).toEqual(["t2"]);
  });

  it("orders by (updated_at, transaction_id) so the cursor is well defined", async () => {
    seedTransaction(database, OWNER, { id: "tb", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "ta", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "tc", updatedAt: "2026-09-30T00:00:00.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows.map((row) => row.transactionId)).toEqual(["tc", "ta", "tb"]);
  });

  it("includes soft-deleted transactions so the mirror can mark them", async () => {
    // 已刪除的交易仍要進鏡像（狀態欄寫已刪除），否則 Sheet 上會留著一列看起來還存在的
    // 交易。查詢若過濾掉 status='deleted'，刪除就永遠不會傳播出去。
    seedTransaction(database, OWNER, {
      id: "t1",
      updatedAt: "2026-10-01T00:00:00.000Z",
      status: "deleted",
    });

    const rows = await repository.listChangedTransactions(OWNER, null, 100);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("deleted");
  });

  it("carries each transaction's allocations", async () => {
    seedTransaction(database, OWNER, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
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
    seedTransaction(database, OWNER, { id: "t1", updatedAt: "2026-10-01T00:00:00.000Z" });
    seedTransaction(database, OWNER, { id: "t2", updatedAt: "2026-10-01T00:00:01.000Z" });
    seedTransaction(database, OWNER, { id: "t3", updatedAt: "2026-10-01T00:00:02.000Z" });

    const rows = await repository.listChangedTransactions(OWNER, null, 2);

    expect(rows.map((row) => row.transactionId)).toEqual(["t1", "t2"]);
  });
});
