import { describe, expect, it } from "vitest";

import type { SheetCell } from "../../src/domain/sheet-rows.js";
import {
  ALLOCATIONS_HEADER,
  MONTHLY_SUMMARY_HEADER,
  TRANSACTIONS_HEADER,
} from "../../src/domain/sheet-rows.js";
import type {
  MirrorTransaction,
  SheetSyncRepository,
  SheetSyncState,
} from "../../src/ports/sheet-sync-repository.js";
import type { SummaryRepository } from "../../src/ports/summary-repository.js";
import { withHeaderRows } from "../../src/sheets/sheet-headers.js";
import {
  ALLOCATIONS_TAB,
  createSheetMirror,
  MONTHLY_SUMMARY_TAB,
  TRANSACTIONS_TAB,
} from "../../src/sheets/sheet-mirror.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

const OWNER = "owner-1";

const ZERO_SUMMARY = {
  actualInflow: { amount: "0", currency: "TWD" as const },
  actualOutflow: { amount: "0", currency: "TWD" as const },
  netCashFlow: { amount: "0", currency: "TWD" as const },
  personalIncome: { amount: "0", currency: "TWD" as const },
  grossPersonalExpense: { amount: "0", currency: "TWD" as const },
  refunds: { amount: "0", currency: "TWD" as const },
  netPersonalExpense: { amount: "0", currency: "TWD" as const },
  personalBalance: { amount: "0", currency: "TWD" as const },
  categories: [],
};

const summaryRepository: SummaryRepository = { summarize: () => Promise.resolve(ZERO_SUMMARY) };

function transaction(id: string): MirrorTransaction {
  return {
    transactionId: id,
    occurredDate: "2026-10-05",
    occurredTime: null,
    amount: "100",
    accountFromName: null,
    accountToName: null,
    merchantName: null,
    counterpartyName: null,
    note: null,
    rawInputSnapshot: null,
    status: "confirmed",
    confirmedAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    allocations: [
      {
        allocationId: `alloc-${id}`,
        fundsEffect: "outflow",
        purpose: "expense",
        amount: "100",
        categoryName: "餐飲",
        subcategoryName: null,
        counterpartyName: null,
        note: null,
      },
    ],
  };
}

/** 一個只回一筆變更、狀態存在記憶體裡的倉儲替身。 */
function syncRepository(changed: MirrorTransaction[]): SheetSyncRepository {
  let state: SheetSyncState = {
    ownerId: OWNER,
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastReconciledAt: null,
  };
  return {
    loadSyncState: () => Promise.resolve(state),
    saveSyncState: (next) => {
      state = next;
      return Promise.resolve();
    },
    listChangedTransactions: (_ownerId, cursor) => Promise.resolve(cursor === null ? changed : []),
    loadAlertAt: () => Promise.resolve(null),
    saveAlertAt: () => Promise.resolve(),
  };
}

function mirrorOver(sheets: FakeSheetsClient, changed: MirrorTransaction[]) {
  return createSheetMirror({
    ownerId: OWNER,
    sheets: withHeaderRows(sheets),
    syncRepository: syncRepository(changed),
    summaryRepository,
    now: () => new Date("2026-10-06T00:00:00.000Z"),
  });
}

const emptySpreadsheet = (): FakeSheetsClient =>
  new FakeSheetsClient({
    [TRANSACTIONS_TAB]: [],
    [ALLOCATIONS_TAB]: [],
    [MONTHLY_SUMMARY_TAB]: [],
  });

describe("標題列", () => {
  it("全新的試算表第一次同步之後，三張分頁的第 1 列就是正確的標題", async () => {
    // Task 7 的審查發現：src/ 裡原本沒有任何程式會寫標題列，三個 header 常數
    // 只被用來算空白列的寬度。引擎永遠從第 2 列開始寫，所以第 1 列會永遠空著——
    // 使用者看到的是一堆沒有欄位名稱的數字，而測試替身的「空標題豁免」剛好
    // 把這件事遮住。
    const sheets = emptySpreadsheet();

    await expect(mirrorOver(sheets, [transaction("t1")]).syncOnce()).resolves.toMatchObject({
      kind: "synced",
    });

    expect(sheets.snapshot(TRANSACTIONS_TAB)[0]).toEqual([...TRANSACTIONS_HEADER]);
    expect(sheets.snapshot(ALLOCATIONS_TAB)[0]).toEqual([...ALLOCATIONS_HEADER]);
    expect(sheets.snapshot(MONTHLY_SUMMARY_TAB)[0]).toEqual([...MONTHLY_SUMMARY_HEADER]);
  });

  it("資料還是從第 2 列開始，標題沒有蓋掉任何一筆資料", async () => {
    const sheets = emptySpreadsheet();

    await mirrorOver(sheets, [transaction("t1")]).syncOnce();

    expect(sheets.snapshot(TRANSACTIONS_TAB)[1]?.[0]).toBe("t1");
    expect(sheets.snapshot(ALLOCATIONS_TAB)[1]?.[0]).toBe("alloc-t1");
  });

  it("使用者改過的標題不會被蓋回去", async () => {
    // 第 1 列只要有任何一格有字就當成「有人管了」。使用者把欄位名稱翻成自己
    // 看得懂的字，不該每次啟動都被改回我們的版本。
    const sheets = new FakeSheetsClient({
      [TRANSACTIONS_TAB]: [["我的交易編號", ...TRANSACTIONS_HEADER.slice(1)]],
      [ALLOCATIONS_TAB]: [],
      [MONTHLY_SUMMARY_TAB]: [],
    });

    await expect(mirrorOver(sheets, [transaction("t1")]).syncOnce()).resolves.toMatchObject({
      kind: "synced",
    });

    expect(sheets.snapshot(TRANSACTIONS_TAB)[0]?.[0]).toBe("我的交易編號");
    expect(sheets.snapshot(ALLOCATIONS_TAB)[0]).toEqual([...ALLOCATIONS_HEADER]);
  });

  it("一個行程只檢查一次，不是每一輪都多花三次讀取", async () => {
    // 這是刻意的取捨：標題列寫過就不會自己消失，而每一輪都檢查等於每 20 秒
    // 多燒三次讀取配額（spec §7）。代價就是這條測試描述的行為——同一個行程裡
    // 事後被清掉的標題列要等下次重啟才會補回來。
    const sheets = emptySpreadsheet();
    const mirror = mirrorOver(sheets, [transaction("t1")]);

    await mirror.syncOnce();
    await sheets.updateCells([
      {
        tab: TRANSACTIONS_TAB,
        rowIndex: 1,
        cells: TRANSACTIONS_HEADER.map((): SheetCell => ({ kind: "empty" })),
      },
    ]);
    const before = sheets.callCount;
    await mirror.syncOnce();

    expect(sheets.snapshot(TRANSACTIONS_TAB)[0]).toEqual(TRANSACTIONS_HEADER.map(() => ""));
    // 第二輪只有引擎自己的呼叫（三讀），沒有那三次標題檢查。
    expect(sheets.callCount - before).toBeLessThan(7);
  });
});
