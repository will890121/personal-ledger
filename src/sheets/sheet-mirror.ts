import { affectedMonths, monthRange, monthlySummaryRow } from "../domain/sheet-months.js";
import { allocationRows, transactionRow } from "../domain/sheet-rows.js";
import { fromSheetSerialDate } from "../domain/sheet-serial-date.js";
import type {
  MirrorTransaction,
  SheetSyncRepository,
  SheetSyncState,
  SyncCursor,
} from "../ports/sheet-sync-repository.js";
import type { CellWrite, SheetsClient } from "../ports/sheets-client.js";
import type { SummaryRepository } from "../ports/summary-repository.js";

export const TRANSACTIONS_TAB = "Transactions";
export const ALLOCATIONS_TAB = "Allocations";
export const MONTHLY_SUMMARY_TAB = "MonthlySummary";

/** 一輪同步最多處理幾筆交易。超過的留給下一輪，游標保證不會倒退。 */
export const SYNC_BATCH = 200;

export interface SheetMirrorDependencies {
  readonly ownerId: string;
  readonly sheets: SheetsClient;
  readonly syncRepository: SheetSyncRepository;
  readonly summaryRepository: SummaryRepository;
  readonly now: () => Date;
}

export type SyncOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "synced"; readonly transactions: number; readonly months: number }
  | { readonly kind: "failed"; readonly error: unknown };

export interface SheetMirror {
  syncOnce(): Promise<SyncOutcome>;
  reconcile(): Promise<SyncOutcome>;
}

/**
 * 某張分頁「鍵 → 列號」的定位表，外加下一個可用的列號。
 *
 * 每一輪都重建，絕不快取：使用者隨時可能在 Sheet 上手動插入或刪除列，記住的列號
 * 下一秒就是錯的。寫到錯的列不會報錯，只會讓某筆資料無聲地出現在別人的 id 底下。
 */
interface RowLocator {
  readonly rowOf: Map<string, number>;
  nextRow: number;
}

function locatorOf(rows: readonly (readonly string[])[]): RowLocator {
  const rowOf = new Map<string, number>();
  // 第 1 列是標題，資料從第 2 列開始；陣列索引 i 對應 1-based 的第 i+1 列。
  for (let i = 1; i < rows.length; i += 1) {
    const key = rows[i]?.[0] ?? "";
    if (key !== "") rowOf.set(key, i + 1);
  }
  // 即使讀回來是空的（分頁還沒建標題），資料也不從第 1 列開始——那是標題的位置。
  return { rowOf, nextRow: Math.max(rows.length + 1, 2) };
}

/** 既有的 id 用它現在的列號；沒見過的接在最後面，並記住，免得同一批裡重複附加。 */
function locate(locator: RowLocator, key: string): number {
  const existing = locator.rowOf.get(key);
  if (existing !== undefined) return existing;
  const appended = locator.nextRow;
  locator.nextRow += 1;
  locator.rowOf.set(key, appended);
  return appended;
}

/**
 * Sheet 上這些 transaction_id 目前記著的日期（`YYYY-MM-DD`）。
 *
 * 空格或不是數字就整筆略過而不是猜一個值：沒有舊值是常態（新交易本來就還沒有列），
 * 猜錯則會去重算一個根本沒被影響的月份，或漏掉真的被影響的那個月。
 */
function previousDatesOf(rows: readonly (readonly string[])[]): Map<string, string> {
  const dates = new Map<string, string>();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const key = row?.[0] ?? "";
    const raw = row?.[1] ?? "";
    if (key === "" || raw.trim() === "") continue;
    const serial = Number(raw);
    if (!Number.isFinite(serial)) continue;
    dates.set(key, fromSheetSerialDate(serial));
  }
  return dates;
}

function cursorOf(state: SheetSyncState): SyncCursor | null {
  if (state.cursorUpdatedAt === null || state.cursorTransactionId === null) return null;
  return { updatedAt: state.cursorUpdatedAt, transactionId: state.cursorTransactionId };
}

/** 游標只前進不後退。校正是全表重掃，這一批的最後一筆很可能比目前的游標還舊。 */
function laterCursor(current: SyncCursor | null, candidate: SyncCursor): SyncCursor {
  if (current === null) return candidate;
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt ? candidate : current;
  }
  return candidate.transactionId > current.transactionId ? candidate : current;
}

export function createSheetMirror(deps: SheetMirrorDependencies): SheetMirror {
  const { ownerId, sheets, syncRepository, summaryRepository, now } = deps;

  async function buildWrites(changed: readonly MirrorTransaction[]): Promise<{
    writes: CellWrite[];
    months: number;
  }> {
    // 三張分頁的鍵欄都是這一輪現讀的。Transactions 順便讀日期欄（B），因為跨月搬移
    // 只能靠 Sheet 上的舊日期才知道舊月份，而這一欄是同一次呼叫裡免費拿到的。
    const transactionKeys = await sheets.readColumns(TRANSACTIONS_TAB, 2);
    const allocationKeys = await sheets.readColumns(ALLOCATIONS_TAB, 1);
    const monthKeys = await sheets.readColumns(MONTHLY_SUMMARY_TAB, 1);

    const transactionLocator = locatorOf(transactionKeys);
    const allocationLocator = locatorOf(allocationKeys);
    const monthLocator = locatorOf(monthKeys);
    const previousDates = previousDatesOf(transactionKeys);

    const writes: CellWrite[] = [];
    for (const txn of changed) {
      writes.push({
        tab: TRANSACTIONS_TAB,
        rowIndex: locate(transactionLocator, txn.transactionId),
        cells: transactionRow(txn),
      });
      const rows = allocationRows(txn);
      txn.allocations.forEach((allocation, index) => {
        const cells = rows[index];
        if (cells === undefined) return;
        writes.push({
          tab: ALLOCATIONS_TAB,
          rowIndex: locate(allocationLocator, allocation.allocationId),
          cells,
        });
      });
    }

    const months = affectedMonths(changed, previousDates);
    const timestamp = now();
    for (const month of months) {
      const summary = await summaryRepository.summarize(ownerId, monthRange(month));
      writes.push({
        tab: MONTHLY_SUMMARY_TAB,
        rowIndex: locate(monthLocator, month),
        cells: monthlySummaryRow(month, summary, timestamp),
      });
    }

    return { writes, months: months.length };
  }

  async function run(mode: "incremental" | "reconcile"): Promise<SyncOutcome> {
    const state = await syncRepository.loadSyncState(ownerId);
    const current = cursorOf(state);
    // 校正走全表（cursor 傳 null），增量從游標繼續。
    const changed = await syncRepository.listChangedTransactions(
      ownerId,
      mode === "reconcile" ? null : current,
      SYNC_BATCH,
    );
    // 沒有變更就一個 Sheets 呼叫都不發。20 秒一輪、每分鐘只有 60 次額度，
    // 空轉也照打會把配額燒在什麼都沒做上（spec §7）。
    if (changed.length === 0) return { kind: "idle" };

    try {
      const { writes, months } = await buildWrites(changed);
      // 一次全有全無的寫入。失敗就整輪不推進，下一輪重做同一批——重寫一列永遠安全。
      await sheets.updateCells(writes);

      const last = changed[changed.length - 1] as MirrorTransaction;
      const nextCursor = laterCursor(current, {
        updatedAt: last.updatedAt,
        transactionId: last.transactionId,
      });
      const nowIso = now().toISOString();
      // 只有寫入成功才存狀態。失敗仍存＝那批變更被永久跳過，而且沒有任何東西會發現。
      await syncRepository.saveSyncState({
        ownerId,
        cursorUpdatedAt: nextCursor.updatedAt,
        cursorTransactionId: nextCursor.transactionId,
        lastSuccessAt: nowIso,
        lastError: null,
        consecutiveFailures: 0,
        lastReconciledAt: mode === "reconcile" ? nowIso : state.lastReconciledAt,
      });
      return { kind: "synced", transactions: changed.length, months };
    } catch (error) {
      // 失敗計數與退避由 Task 8 的包裝負責，這裡只負責「不推進」。
      return { kind: "failed", error };
    }
  }

  return {
    syncOnce: () => run("incremental"),
    reconcile: () => run("reconcile"),
  };
}
