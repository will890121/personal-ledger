import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";
import { SqliteSummaryRepository } from "../../src/db/sqlite-summary-repository.js";
import type { SheetCell } from "../../src/domain/sheet-rows.js";
import {
  ALLOCATIONS_HEADER,
  MONTHLY_SUMMARY_HEADER,
  TRANSACTIONS_HEADER,
  allocationRows,
  transactionRow,
} from "../../src/domain/sheet-rows.js";
import type { SheetMirror } from "../../src/sheets/sheet-mirror.js";
import { SYNC_BATCH, createSheetMirror } from "../../src/sheets/sheet-mirror.js";
import { seedTransaction } from "../fixtures/sheet-sync-seed.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

/**
 * 收斂性：塵埃落定之後，Sheet 上「鏡像自己寫的那些列」必須等於直接從 SQLite 算出來的
 * 投影——一列不多、一列不少。
 *
 * 這一組測試刻意不看實作。它們不問「reconcile 有沒有分頁」、不問「清理走哪條分支」，
 * 只問最後三張分頁對不對。用真的 SQLite 倉儲、真的摘要倉儲、位置定址的 Sheets 模擬器，
 * 因為被驗的東西正是「倉儲的游標查詢」與「引擎算出來的列號」之間的接縫。
 *
 * 但這裡的期望值是拿被測程式自己的投影函式（transactionRow / allocationRows）算出來
 * 的，所以這一組只咬得住「列存不存在、有沒有重複、有沒有殭屍列」這種版面層級的錯——
 * 投影函式內部的欄位錯位或寫錯值，會被這裡的期望值恆真地放過。那一段由
 * tests/domain/sheet-rows.test.ts 的逐格字面斷言負責；兩組合起來，一個寫錯的實作
 * 才真的無所遁形，不只是「沒有實作」會被抓到。
 */

const OWNER = "owner-1";
const NOW = new Date("2026-10-08T05:00:00.000Z");

/**
 * 測試用的 id 一律做成 UUID 形狀。
 *
 * 真實的交易與配置 id 全部來自 `randomUUID()`，而清理的判準正是「UUID 形狀 + SQLite
 * 裡找不到」。用 `t1` 這種短名字會讓整條清理路徑在測試裡永遠走不到，看起來全綠。
 */
const uuid = (label: string): string => `00000000-0000-4000-8000-${label.padStart(12, "0")}`;

const T1 = uuid("1");
const T2 = uuid("2");
const T3 = uuid("3");
const T4 = uuid("4");
const A1 = uuid("a1");
const A1B = uuid("a1b");
const A2 = uuid("a2");
const A2B = uuid("a2b");
const A3 = uuid("a3");
const A4 = uuid("a4");

/** 與引擎同一套判準：這一列只可能是鏡像寫的。 */
const MIRROR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const renderCell = (cell: SheetCell): string => {
  switch (cell.kind) {
    case "string":
      return cell.value;
    case "number":
    case "date":
      return String(cell.value);
    case "empty":
      return "";
  }
};

/** 只留有內容的資料列：標題不算，被清空的列也不算（空白列會累積，這是已知的代價）。 */
const dataRows = (rows: readonly string[][]): string[][] =>
  rows.slice(1).filter((row) => row.some((cell) => cell !== ""));

/**
 * 鏡像自己寫的資料列。不變量只涵蓋這些列：使用者手打的內容不屬於投影，
 * 也不該被鏡像碰，所以不參與比較。
 */
const mirrorRows = (rows: readonly string[][]): string[][] =>
  rows.slice(1).filter((row) => MIRROR_ID.test(row[0] ?? ""));

const sorted = (rows: readonly string[][]): string[][] =>
  [...rows]
    .map((row) => [...row])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function emptyWorkbook(): FakeSheetsClient {
  return new FakeSheetsClient({
    Transactions: [[...TRANSACTIONS_HEADER]],
    Allocations: [[...ALLOCATIONS_HEADER]],
    MonthlySummary: [[...MONTHLY_SUMMARY_HEADER]],
  });
}

describe("sheet mirror convergence", () => {
  let database: Database.Database;
  let syncRepository: SqliteSheetSyncRepository;
  let summaryRepository: SqliteSummaryRepository;

  beforeEach(() => {
    database = new Database(":memory:");
    migrate(database);
    syncRepository = new SqliteSheetSyncRepository(database);
    summaryRepository = new SqliteSummaryRepository(database);
    // 全新資料庫上 categories 是空的（migration 0002 只搬既有交易），配置的外鍵需要它。
    database
      .prepare(
        `INSERT INTO categories (category_id, owner_id, key, name, kind, depth, active)
         VALUES ('cat-1', ?, 'expense_dining', '餐飲', 'expense', 1, 1)`,
      )
      .run(OWNER);
  });

  afterEach(() => {
    database.close();
  });

  const mirrorOver = (sheets: FakeSheetsClient): SheetMirror =>
    createSheetMirror({
      ownerId: OWNER,
      sheets,
      syncRepository,
      summaryRepository,
      now: () => NOW,
    });

  function addAllocation(input: {
    allocationId: string;
    transactionId: string;
    amount: string;
  }): void {
    database
      .prepare(
        `INSERT INTO allocations (
           allocation_id, transaction_id, funds_effect, purpose, amount, currency,
           category_id, category_snapshot, subcategory_snapshot
         ) VALUES (?, ?, 'outflow', 'expense', ?, 'TWD', 'cat-1', '餐飲', '午餐')`,
      )
      .run(input.allocationId, input.transactionId, input.amount);
  }

  /** 改一筆交易，順便推進 updated_at——否則增量同步看不到這次變更。 */
  function touch(
    transactionId: string,
    changes: { updatedAt: string; occurredDate?: string; amount?: string; status?: string },
  ): void {
    const row = database
      .prepare("SELECT occurred_date, amount, status FROM transactions WHERE transaction_id = ?")
      .get(transactionId) as { occurred_date: string; amount: string; status: string };
    database
      .prepare(
        `UPDATE transactions SET occurred_date = ?, amount = ?, status = ?, updated_at = ?
         WHERE transaction_id = ?`,
      )
      .run(
        changes.occurredDate ?? row.occurred_date,
        changes.amount ?? row.amount,
        changes.status ?? row.status,
        changes.updatedAt,
        transactionId,
      );
  }

  /** 一整列的原始字串，鍵欄放 `key`，其餘留空。用來擺殭屍列與使用者手打的列。 */
  const rawRow = (key: string, width: number): string[] => {
    const row = Array.from({ length: width }, () => "");
    row[0] = key;
    return row;
  };

  /**
   * 期望的投影：直接從 SQLite 讀出全部交易，用同一組投影函式算出應該出現的列。
   * 比較的是「哪些列存在」——沒有殭屍列、沒有重複列、該有的一列都不少。
   */
  async function expectedProjection(): Promise<{
    transactions: string[][];
    allocations: string[][];
  }> {
    const all = await syncRepository.listChangedTransactions(OWNER, null, 10_000);
    return {
      transactions: all.map((txn) => transactionRow(txn).map(renderCell)),
      allocations: all.flatMap((txn) => allocationRows(txn).map((row) => row.map(renderCell))),
    };
  }

  async function expectConverged(sheets: FakeSheetsClient): Promise<void> {
    const expected = await expectedProjection();
    expect(sorted(mirrorRows(sheets.snapshot("Transactions")))).toEqual(
      sorted(expected.transactions),
    );
    expect(sorted(mirrorRows(sheets.snapshot("Allocations")))).toEqual(
      sorted(expected.allocations),
    );
  }

  it("projects sqlite onto the sheet after a sequence of changes", async () => {
    // 建立、修改（含配置換 id）、跨月搬移、軟刪除各一次。
    seedTransaction(database, OWNER, {
      id: T1,
      updatedAt: "2026-10-05T00:00:01.000Z",
      occurredDate: "2026-10-02",
    });
    addAllocation({ allocationId: A1, transactionId: T1, amount: "100" });
    seedTransaction(database, OWNER, {
      id: T2,
      updatedAt: "2026-10-05T00:00:02.000Z",
      occurredDate: "2026-10-03",
      amount: "200",
    });
    addAllocation({ allocationId: A2, transactionId: T2, amount: "200" });
    seedTransaction(database, OWNER, {
      id: T3,
      updatedAt: "2026-10-05T00:00:03.000Z",
      occurredDate: "2026-09-20",
      amount: "300",
    });
    addAllocation({ allocationId: A3, transactionId: T3, amount: "300" });
    seedTransaction(database, OWNER, {
      id: T4,
      updatedAt: "2026-10-05T00:00:04.000Z",
      occurredDate: "2026-10-04",
      amount: "400",
    });
    addAllocation({ allocationId: A4, transactionId: T4, amount: "400" });

    const sheets = emptyWorkbook();
    const mirror = mirrorOver(sheets);
    expect((await mirror.syncOnce()).kind).toBe("synced");
    await expectConverged(sheets);

    // 修改 T2：updateTransaction 是「DELETE 全部配置再 INSERT」，所以 A2 消失、A2B 出現。
    database.prepare("DELETE FROM allocations WHERE transaction_id = ?").run(T2);
    addAllocation({ allocationId: A2B, transactionId: T2, amount: "250" });
    touch(T2, { updatedAt: "2026-10-06T00:00:01.000Z", amount: "250" });
    // 跨月搬移 T3：9 月與 10 月的摘要都變了。
    touch(T3, { updatedAt: "2026-10-06T00:00:02.000Z", occurredDate: "2026-10-20" });
    // 軟刪除 T4：交易列留著，狀態欄改成 deleted。
    touch(T4, { updatedAt: "2026-10-06T00:00:03.000Z", status: "deleted" });

    expect((await mirror.syncOnce()).kind).toBe("synced");

    await expectConverged(sheets);
    const transactions = mirrorRows(sheets.snapshot("Transactions"));
    expect(transactions).toHaveLength(4);
    expect([...transactions.map((row) => row[0])].sort()).toEqual([T1, T2, T3, T4].sort());
    // A2 的列必須真的不見了，否則樞紐分析會把已經不存在的 200 元算進去。
    const allocationIds = mirrorRows(sheets.snapshot("Allocations")).map((row) => row[0]);
    expect([...allocationIds].sort()).toEqual([A1, A2B, A3, A4].sort());
    // 跨月搬移要讓兩個月都被重算，所以兩個月份都該有摘要列。
    expect(dataRows(sheets.snapshot("MonthlySummary")).map((row) => row[0])).toEqual([
      "2026-09",
      "2026-10",
    ]);
  });

  it("is idempotent: syncing the same batch twice leaves the sheet unchanged", async () => {
    // 冪等是整個設計賴以成立的前提——因為冪等，才敢在失敗後整批重做、
    // 才敢讓校正把每一筆都重寫一次。
    seedTransaction(database, OWNER, { id: T1, updatedAt: "2026-10-05T00:00:01.000Z" });
    addAllocation({ allocationId: A1, transactionId: T1, amount: "100" });
    seedTransaction(database, OWNER, {
      id: T2,
      updatedAt: "2026-10-05T00:00:02.000Z",
      occurredDate: "2026-09-11",
      amount: "200",
    });
    addAllocation({ allocationId: A2, transactionId: T2, amount: "200" });

    const sheets = emptyWorkbook();
    const mirror = mirrorOver(sheets);
    await mirror.syncOnce();
    const before = {
      transactions: sheets.snapshot("Transactions"),
      allocations: sheets.snapshot("Allocations"),
      months: sheets.snapshot("MonthlySummary"),
    };

    // 把游標倒回起點，讓同一批完整地再跑一次。
    const state = await syncRepository.loadSyncState(OWNER);
    await syncRepository.saveSyncState({
      ...state,
      cursorUpdatedAt: null,
      cursorTransactionId: null,
    });
    expect((await mirror.syncOnce()).kind).toBe("synced");

    expect(sheets.snapshot("Transactions")).toEqual(before.transactions);
    expect(sheets.snapshot("Allocations")).toEqual(before.allocations);
    expect(sheets.snapshot("MonthlySummary")).toEqual(before.months);
  });

  it("converges after the sheet is corrupted by hand", async () => {
    seedTransaction(database, OWNER, { id: T1, updatedAt: "2026-10-05T00:00:01.000Z" });
    addAllocation({ allocationId: A1, transactionId: T1, amount: "100" });
    seedTransaction(database, OWNER, {
      id: T2,
      updatedAt: "2026-10-05T00:00:02.000Z",
      amount: "200",
    });
    addAllocation({ allocationId: A2, transactionId: T2, amount: "200" });
    seedTransaction(database, OWNER, {
      id: T3,
      updatedAt: "2026-10-05T00:00:03.000Z",
      amount: "300",
    });
    addAllocation({ allocationId: A3, transactionId: T3, amount: "300" });

    const clean = emptyWorkbook();
    await mirrorOver(clean).syncOnce();
    await expectConverged(clean);

    // 使用者動手改壞：改一格金額、刪掉一整列、在中間插一列。
    const corruptedTransactions = clean.snapshot("Transactions");
    const t1Row = corruptedTransactions.findIndex((row) => row[0] === T1);
    const editedT1 = [...(corruptedTransactions[t1Row] as string[])];
    editedT1[3] = "999999";
    corruptedTransactions[t1Row] = editedT1;
    const t2Row = corruptedTransactions.findIndex((row) => row[0] === T2);
    corruptedTransactions.splice(t2Row, 1);
    corruptedTransactions.splice(2, 0, ["我自己的備註"]);
    const corruptedAllocations = clean.snapshot("Allocations");
    corruptedAllocations.splice(1, 1);

    const corrupted = new FakeSheetsClient({
      Transactions: corruptedTransactions,
      Allocations: corruptedAllocations,
      MonthlySummary: clean.snapshot("MonthlySummary"),
    });

    const outcome = await mirrorOver(corrupted).reconcile();

    expect(outcome.kind).toBe("synced");
    await expectConverged(corrupted);
    // 被改掉的那一格要被寫回正確值。
    const restored = corrupted.snapshot("Transactions").find((row) => row[0] === T1);
    expect(restored?.[3]).toBe("100");
    // 而使用者自己寫的那一列不屬於投影，也不該被鏡像碰。
    expect(corrupted.snapshot("Transactions").some((row) => row[0] === "我自己的備註")).toBe(true);
  });

  it("reconcile covers rows the delta cursor never saw", async () => {
    // M1 那些沒有稽核事件、且游標已經越過的交易：增量永遠撈不到，校正必須撈到。
    seedTransaction(database, OWNER, { id: T1, updatedAt: "2026-09-01T00:00:01.000Z" });
    addAllocation({ allocationId: A1, transactionId: T1, amount: "100" });
    seedTransaction(database, OWNER, { id: T2, updatedAt: "2026-09-01T00:00:02.000Z" });

    await syncRepository.saveSyncState({
      ownerId: OWNER,
      cursorUpdatedAt: "2026-12-31T00:00:00.000Z",
      cursorTransactionId: uuid("f"),
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      lastReconciledAt: null,
    });

    const sheets = emptyWorkbook();
    const mirror = mirrorOver(sheets);

    expect((await mirror.syncOnce()).kind).toBe("idle");
    expect(sheets.callCount).toBe(0);
    expect(dataRows(sheets.snapshot("Transactions"))).toEqual([]);

    expect((await mirror.reconcile()).kind).toBe("synced");

    await expectConverged(sheets);
    // 校正不准讓游標倒退，否則之後每一輪增量都要重走一遍所有東西。
    const state = await syncRepository.loadSyncState(OWNER);
    expect(state.cursorUpdatedAt).toBe("2026-12-31T00:00:00.000Z");
    expect(state.cursorTransactionId).toBe(uuid("f"));
    expect(state.lastReconciledAt).toBe(NOW.toISOString());
  });

  it("reconcile reaches past the first SYNC_BATCH page in a single call", async () => {
    // Task 6 審查實測：`reconcile` 若只把 cursor 傳 null 而不自己分頁，查詢永遠回傳
    // 最舊的那 SYNC_BATCH 筆，laterCursor 又把推進丟掉——連跑五次都停在同一個地方，
    // 而且每次都回報成功。被手動改壞的第 500 列於是永遠不會被修正。
    const total = SYNC_BATCH + 25;
    for (let i = 0; i < total; i += 1) {
      seedTransaction(database, OWNER, {
        id: uuid(String(i)),
        updatedAt: `2026-10-05T00:00:00.${String(i).padStart(3, "0")}Z`,
      });
    }
    const lastId = uuid(String(total - 1));

    const sheets = emptyWorkbook();
    const outcome = await mirrorOver(sheets).reconcile();

    expect(outcome).toEqual({ kind: "synced", transactions: total, months: 1 });
    const ids = mirrorRows(sheets.snapshot("Transactions")).map((row) => row[0]);
    expect(ids).toHaveLength(total);
    expect(ids).toContain(lastId);
    // 全表掃完之後，持久游標應該停在真正的最後一筆。
    const state = await syncRepository.loadSyncState(OWNER);
    expect(state.cursorTransactionId).toBe(lastId);
  });

  it("clears a transactions row whose id no longer exists in sqlite", async () => {
    // 殭屍列有兩種：來源已經不在 SQLite 的 id，以及同一個 id 的重複列
    // （引擎是後寫獲勝，較早那一列永遠不會再被覆寫）。兩者都讓
    // 「Sheet 是 SQLite 的投影」不成立。
    seedTransaction(database, OWNER, { id: T1, updatedAt: "2026-10-05T00:00:01.000Z" });

    const ghost = rawRow(uuid("dead"), TRANSACTIONS_HEADER.length);
    const duplicate = rawRow(T1, TRANSACTIONS_HEADER.length);
    const sheets = new FakeSheetsClient({
      Transactions: [[...TRANSACTIONS_HEADER], duplicate, ghost, [...duplicate]],
      Allocations: [[...ALLOCATIONS_HEADER]],
      MonthlySummary: [[...MONTHLY_SUMMARY_HEADER]],
    });

    expect((await mirrorOver(sheets).reconcile()).kind).toBe("synced");

    await expectConverged(sheets);
    expect(mirrorRows(sheets.snapshot("Transactions")).map((row) => row[0])).toEqual([T1]);
    // 清空而不是刪除列：列數不變。
    expect(sheets.snapshot("Transactions")).toHaveLength(4);
  });

  it("clears a stale mirror row but never a hand-typed one", async () => {
    // 這條守的是一個比殭屍列嚴重得多的失敗模式：使用者貼幾列上個月的資料來比對、
    // 在空白列寫給自己的備註，然後半夜的校正靜靜地把它們清掉——沒有警告，也拿不回來。
    //
    // 判準必須是「UUID 形狀」而不是「鍵欄非空」：真實 id 全部來自 randomUUID()，
    // 所以 UUID 形狀剛好等於「這一列只可能是鏡像寫的」。少了這條測試，之後某次
    // 重構會把規則悄悄放寬回去，而不會有任何東西反對。
    seedTransaction(database, OWNER, { id: T1, updatedAt: "2026-10-05T00:00:01.000Z" });
    addAllocation({ allocationId: A1, transactionId: T1, amount: "100" });

    const sheets = new FakeSheetsClient({
      Transactions: [
        [...TRANSACTIONS_HEADER],
        rawRow(uuid("dead"), TRANSACTIONS_HEADER.length),
        rawRow("我自己的備註", TRANSACTIONS_HEADER.length),
        rawRow("上個月對帳用", TRANSACTIONS_HEADER.length),
      ],
      Allocations: [
        [...ALLOCATIONS_HEADER],
        rawRow(uuid("beef"), ALLOCATIONS_HEADER.length),
        rawRow("這格是我自己算的", ALLOCATIONS_HEADER.length),
      ],
      MonthlySummary: [[...MONTHLY_SUMMARY_HEADER]],
    });

    expect((await mirrorOver(sheets).reconcile()).kind).toBe("synced");

    await expectConverged(sheets);
    // 鏡像寫的殭屍列：清掉。
    const transactionKeys = sheets.snapshot("Transactions").map((row) => row[0]);
    expect(transactionKeys).not.toContain(uuid("dead"));
    expect(sheets.snapshot("Allocations").map((row) => row[0])).not.toContain(uuid("beef"));
    // 使用者手打的列：一格都不准動。
    expect(transactionKeys).toContain("我自己的備註");
    expect(transactionKeys).toContain("上個月對帳用");
    expect(sheets.snapshot("Allocations").map((row) => row[0])).toContain("這格是我自己算的");
  });

  it("clears an allocation row whose allocation no longer exists", async () => {
    // updateTransaction 是「DELETE 全部配置再 INSERT」，所以改一筆交易之後舊的
    // allocation_id 就永遠消失了。這條走的是增量路徑：這個缺口不能只有每日校正
    // 才補得起來，不然使用者改完一筆帳，最多要等一天 Sheet 上的金額才會對。
    seedTransaction(database, OWNER, { id: T1, updatedAt: "2026-10-05T00:00:01.000Z" });
    addAllocation({ allocationId: A1, transactionId: T1, amount: "100" });

    const sheets = emptyWorkbook();
    const mirror = mirrorOver(sheets);
    await mirror.syncOnce();
    expect(mirrorRows(sheets.snapshot("Allocations")).map((row) => row[0])).toEqual([A1]);

    database.prepare("DELETE FROM allocations WHERE transaction_id = ?").run(T1);
    addAllocation({ allocationId: A1B, transactionId: T1, amount: "150" });
    touch(T1, { updatedAt: "2026-10-06T00:00:01.000Z", amount: "150" });

    expect((await mirror.syncOnce()).kind).toBe("synced");

    await expectConverged(sheets);
    expect(mirrorRows(sheets.snapshot("Allocations")).map((row) => row[0])).toEqual([A1B]);
    // A1 原本那一列被清空而不是刪除，所以分頁仍然是「標題 + 兩列」。
    expect(sheets.snapshot("Allocations")).toHaveLength(3);
  });
});
