import { affectedMonths, monthRange, monthlySummaryRow } from "../domain/sheet-months.js";
import type { SheetCell } from "../domain/sheet-rows.js";
import {
  ALLOCATIONS_HEADER,
  TRANSACTIONS_HEADER,
  allocationRows,
  transactionRow,
} from "../domain/sheet-rows.js";
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

/**
 * 一次校正最多分幾頁（保險絲，不是設計上的上限）。
 *
 * 校正在同一次呼叫內自己分頁直到撈完為止，正常情況下由「這一批不滿 SYNC_BATCH」
 * 結束。這個上限只防一種情形：倉儲若因為資料異常而一直回傳滿滿的一批、游標卻不
 * 前進，迴圈會永遠轉下去、把配額燒光。被上限截斷時我們刻意不清殭屍列——見
 * `clearGhostRows` 的說明。
 */
export const RECONCILE_MAX_PAGES = 100;

/** 整列清空用的空白格。清空而不是刪除列：刪除會讓列號位移，清空是冪等的。 */
const blankRow = (width: number): SheetCell[] =>
  Array.from({ length: width }, (): SheetCell => ({ kind: "empty" }));

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
 * 日期欄唯一接受的形狀：純十進位數字，可帶小數（Sheets 的日期時間序列值）。
 * 不能用 `Number()` 加 `Number.isFinite` 代替——`Number("0x10")` 是 16，
 * 一格使用者亂打的內容就會被當成 1900-01-16，多重算一個根本沒被影響的月份。
 */
const DECIMAL_SERIAL = /^\d+(?:\.\d+)?$/;

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
    const raw = (row?.[1] ?? "").trim();
    if (key === "" || !DECIMAL_SERIAL.test(raw)) continue;
    dates.set(key, fromSheetSerialDate(Number(raw)));
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
    months: string[];
  }> {
    // 三張分頁的鍵欄都是這一輪現讀的。Transactions 順便讀日期欄（B），因為跨月搬移
    // 只能靠 Sheet 上的舊日期才知道舊月份，而這一欄是同一次呼叫裡免費拿到的。
    const transactionKeys = await sheets.readColumns(TRANSACTIONS_TAB, 2);
    // Allocations 讀 A:B（allocation_id 與 transaction_id）。只讀 A 欄的話，就無法
    // 知道 Sheet 上哪些列掛在正在處理的這筆交易底下——而 updateTransaction 是
    // 「DELETE 全部配置再 INSERT」，改過一次之後舊的 allocation_id 就永遠消失了。
    // 只 upsert 不清理的話那些列會永遠留在 Sheet 上，使用者拿 Allocations 分頁做
    // 樞紐分析時會把已經不存在的金額算進去：一張靜默地算錯錢的試算表。
    const allocationKeys = await sheets.readColumns(ALLOCATIONS_TAB, 2);
    const monthKeys = await sheets.readColumns(MONTHLY_SUMMARY_TAB, 1);

    const transactionLocator = locatorOf(transactionKeys);
    const allocationLocator = locatorOf(allocationKeys);
    const monthLocator = locatorOf(monthKeys);
    const previousDates = previousDatesOf(transactionKeys);

    const writes: CellWrite[] = [];
    // 這一輪已經被寫入佔用的配置列。清空只能清沒被佔用的列：同一批裡兩筆寫到
    // 同一列是「引擎算錯列號」的訊號，客戶端會直接拋錯（模擬器也一樣）。
    const claimedAllocationRows = new Set<number>();
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
        const rowIndex = locate(allocationLocator, allocation.allocationId);
        claimedAllocationRows.add(rowIndex);
        writes.push({ tab: ALLOCATIONS_TAB, rowIndex, cells });
      });
    }

    // 掛在這一批交易底下、但這一輪不會被覆寫的配置列，整列清空。兩種來源：
    // 配置已經不存在（改交易時 allocation_id 換掉了），或同一個 allocation_id 的
    // 重複列（定位表只指向最後一列，較早那些會變成永遠不再被覆寫的殭屍列）。
    const changedIds = new Set(changed.map((txn) => txn.transactionId));
    for (let i = 1; i < allocationKeys.length; i += 1) {
      const rowIndex = i + 1;
      if (!changedIds.has(allocationKeys[i]?.[1] ?? "")) continue;
      if (claimedAllocationRows.has(rowIndex)) continue;
      writes.push({
        tab: ALLOCATIONS_TAB,
        rowIndex,
        cells: blankRow(ALLOCATIONS_HEADER.length),
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

    return { writes, months };
  }

  /**
   * 校正的收尾：清掉 Sheet 上已經沒有來源的列。
   *
   * 只有校正能做這件事，而且只有在全表真的掃完之後才能做：`knownIds` 是「SQLite
   * 裡存在的所有交易」，判斷「不存在」必須拿完整的集合來比。增量同步只看得到一批
   * 變更，拿那一批去比會把整張 Sheet 清光；校正被迭代上限截斷時同理，所以那種情形
   * 直接跳過清理——少清一輪只是晚一天修好，清錯則是資料消失。
   */
  async function clearGhostRows(knownIds: ReadonlySet<string>): Promise<void> {
    const transactionKeys = await sheets.readColumns(TRANSACTIONS_TAB, 1);
    const allocationKeys = await sheets.readColumns(ALLOCATIONS_TAB, 2);
    const writes: CellWrite[] = [];

    // 同一個 id 出現多次時，定位表指向最後一列（引擎是後寫獲勝），較早那幾列
    // 就再也不會被覆寫。留最後一列、清掉其餘的。
    const lastRowOf = new Map<string, number>();
    for (let i = 1; i < transactionKeys.length; i += 1) {
      const key = transactionKeys[i]?.[0] ?? "";
      if (key !== "") lastRowOf.set(key, i + 1);
    }
    for (let i = 1; i < transactionKeys.length; i += 1) {
      const key = transactionKeys[i]?.[0] ?? "";
      // 空白列本來就是清空的結果，再寫一次只是浪費配額。
      if (key === "") continue;
      const rowIndex = i + 1;
      if (knownIds.has(key) && lastRowOf.get(key) === rowIndex) continue;
      writes.push({
        tab: TRANSACTIONS_TAB,
        rowIndex,
        cells: blankRow(TRANSACTIONS_HEADER.length),
      });
    }

    // 配置列的孤兒：transaction_id 已經不在 SQLite 裡（那一格是空的也算）。
    // 掛在現有交易底下、但配置已經不存在的列由 buildWrites 負責——校正會處理到
    // 每一筆交易，所以兩者合起來覆蓋了全部情形。
    for (let i = 1; i < allocationKeys.length; i += 1) {
      const row = allocationKeys[i] ?? [];
      if ((row[0] ?? "") === "" && (row[1] ?? "") === "") continue;
      if (knownIds.has(row[1] ?? "")) continue;
      writes.push({
        tab: ALLOCATIONS_TAB,
        rowIndex: i + 1,
        cells: blankRow(ALLOCATIONS_HEADER.length),
      });
    }

    // 沒有殭屍列就不要多發一次寫入。校正每天都跑，配額是有限的（spec §7）。
    if (writes.length > 0) await sheets.updateCells(writes);
  }

  async function run(mode: "incremental" | "reconcile"): Promise<SyncOutcome> {
    const state = await syncRepository.loadSyncState(ownerId);
    const persisted = cursorOf(state);

    // 增量從持久游標繼續、一輪只做一批（超過的留給下一輪）；校正走全表，而且是在
    // 同一次呼叫內用自己的**區域**游標往前分頁。
    //
    // 為什麼校正不能「一次一批、靠持久游標下一輪繼續」：全表掃描的第一批永遠是最舊
    // 的那 SYNC_BATCH 筆，而 laterCursor 會把這一批的推進丟掉（持久游標已經在前面）。
    // 結果是每次校正都只重驗最舊的那幾筆，永遠到不了其餘資料——被手動改壞的第 500
    // 列永遠不會被修正，而自我修復是這整個設計的賣點（spec §2、§9）。
    let cursor = mode === "reconcile" ? null : persisted;
    const maxPages = mode === "reconcile" ? RECONCILE_MAX_PAGES : 1;

    const months = new Set<string>();
    // 校正撈到的所有交易 id。走完全表才代表它是完整的，才能拿來判斷殭屍列。
    const knownIds = new Set<string>();
    let transactions = 0;
    let advanced: SyncCursor | null = null;
    let scannedToEnd = false;

    try {
      for (let page = 0; page < maxPages; page += 1) {
        const changed = await syncRepository.listChangedTransactions(ownerId, cursor, SYNC_BATCH);
        // 沒有變更就一個 Sheets 呼叫都不發。20 秒一輪、每分鐘只有 60 次額度，
        // 空轉也照打會把配額燒在什麼都沒做上（spec §7）。
        if (changed.length === 0) {
          scannedToEnd = true;
          break;
        }

        const built = await buildWrites(changed);
        // 一次全有全無的寫入。失敗就整輪不推進，下一輪重做同一批——重寫一列永遠安全。
        await sheets.updateCells(built.writes);
        for (const month of built.months) months.add(month);
        for (const txn of changed) knownIds.add(txn.transactionId);
        transactions += changed.length;

        const last = changed[changed.length - 1] as MirrorTransaction;
        advanced = { updatedAt: last.updatedAt, transactionId: last.transactionId };
        cursor = advanced;
        // 這一批不滿就是撈完了；滿的話還有後續，同一次呼叫內繼續往前翻。
        if (changed.length < SYNC_BATCH) {
          scannedToEnd = true;
          break;
        }
      }

      if (advanced === null) return { kind: "idle" };

      if (mode === "reconcile" && scannedToEnd) await clearGhostRows(knownIds);

      // 游標只前進不後退：校正這一輪的最後一筆可能比持久游標還舊。
      const nextCursor = laterCursor(persisted, advanced);
      const nowIso = now().toISOString();
      // 只有寫入成功才存狀態。失敗仍存＝那批變更被永久跳過，而且沒有任何東西會發現。
      await syncRepository.saveSyncState({
        ownerId,
        cursorUpdatedAt: nextCursor.updatedAt,
        cursorTransactionId: nextCursor.transactionId,
        lastSuccessAt: nowIso,
        lastError: null,
        consecutiveFailures: 0,
        // 只有真的走完全表才算「校正過了」。被迭代上限截斷時這一輪並沒有驗完整張
        // Sheet，蓋上時間戳就等於把一個需要有人來看的狀況說成成功。
        lastReconciledAt: mode === "reconcile" && scannedToEnd ? nowIso : state.lastReconciledAt,
      });
      return { kind: "synced", transactions, months: months.size };
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
