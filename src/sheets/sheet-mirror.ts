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
import { describeSheetFailure, ESCALATE_AFTER_FAILURES } from "./sheet-failure.js";

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

/**
 * 「這一列只可能是鏡像自己寫的」的判準。
 *
 * 交易 id 與配置 id 全部來自 `randomUUID()`，所以「UUID 形狀」剛好等於「來自鏡像」。
 * 清理只動通過這個形狀檢查、而且 SQLite 裡已經找不到的列。
 *
 * 為什麼不是「鍵欄非空就清」：使用者會貼幾列上個月的資料來比對、會在空白列寫給自己
 * 的備註。那些東西過不了 UUID 形狀檢查，必須原封不動留著——每天半夜靜靜地把使用者
 * 手打的內容清掉，沒有警告也拿不回來，比它要修的殭屍列嚴重得多。要清的從來不是
 * 「使用者加了東西」，而是「鏡像自己留下了來源已經不存在的列」。
 */
const MIRROR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SheetMirrorDependencies {
  readonly ownerId: string;
  readonly sheets: SheetsClient;
  readonly syncRepository: SheetSyncRepository;
  readonly summaryRepository: SummaryRepository;
  readonly now: () => Date;
  /**
   * 連續失敗達到 `ESCALATE_AFTER_FAILURES` 時呼叫，把「鏡像已經停住」這件事
   * 交給呼叫端去通知使用者（Task 10／11／12 接到 Telegram）。
   *
   * 這裡刻意不 import grammY：注入點只知道「需要有人注意」，接到哪一種
   * 通知管道是呼叫端的事。省略時視同不通知（例如尚未接上真正的通知管道）。
   */
  readonly onNeedsAttention?: (state: SheetSyncState) => Promise<void> | void;
  /**
   * 覆寫 `RECONCILE_MAX_PAGES`，只給測試用。
   *
   * 正常撈兩萬筆才會撞到截斷路徑，測試沒必要（也沒時間）seed 那麼多筆——把這個
   * 上限做成可注入，測試就能用小值逼出截斷分支。**正式環境永遠不傳這個欄位**，
   * 用的就是 `RECONCILE_MAX_PAGES` 這個預設值；這裡不是給維運調整用的旋鈕。
   */
  readonly reconcileMaxPages?: number;
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

/** 通知節流：同一個狀況十分鐘內只講一次，不要洗版使用者。 */
const NOTIFY_THROTTLE_MS = 10 * 60_000;

export function createSheetMirror(deps: SheetMirrorDependencies): SheetMirror {
  const {
    ownerId,
    sheets,
    syncRepository,
    summaryRepository,
    now,
    onNeedsAttention,
    reconcileMaxPages,
  } = deps;

  // 沿用 notify-attention.ts 裁決過的語意：只在通知「送出成功」時才蓋節流時間戳。
  // 送失敗代表使用者根本沒收到，不該因此吃掉接下來十分鐘的靜默窗口。
  let lastNotifiedAtMs: number | null = null;

  async function notifyNeedsAttention(state: SheetSyncState): Promise<void> {
    if (onNeedsAttention === undefined) return;
    const nowMs = now().getTime();
    if (lastNotifiedAtMs !== null && nowMs - lastNotifiedAtMs < NOTIFY_THROTTLE_MS) return;
    try {
      await onNeedsAttention(state);
    } catch {
      // 吞掉：通知失敗是「盡力而為」——不能讓 syncOnce 跟著拋錯，也不能因為
      // 這次沒送到就當作節流窗口已經用掉（見上方註解）。
      return;
    }
    lastNotifiedAtMs = nowMs;
  }

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
      // 鍵欄不是 UUID 形狀就不是鏡像寫的，不管它掛在誰底下都不准動。
      if (!MIRROR_ID.test(allocationKeys[i]?.[0] ?? "")) continue;
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
   * 校正的收尾：清掉鏡像自己留下、但來源已經不存在的列。
   *
   * 判準是兩個條件同時成立：鍵欄是 UUID 形狀（`MIRROR_ID`，代表這一列只可能是鏡像
   * 寫的），而且那個 UUID 在 SQLite 裡找不到。使用者手打的內容過不了第一個條件，
   * 一格都不會被動到。
   *
   * 只有校正能做這件事，而且只有在全表真的掃完之後才能做：`known` 是「SQLite 裡存在
   * 的所有 id」，判斷「不存在」必須拿完整的集合來比。增量同步只看得到一批變更，拿那
   * 一批去比會把整張 Sheet 清光；校正被迭代上限截斷時同理，所以那種情形直接跳過
   * 清理——少清一輪只是晚一天修好，清錯則是資料消失。
   */
  async function clearGhostRows(known: {
    readonly transactions: ReadonlySet<string>;
    readonly allocations: ReadonlySet<string>;
  }): Promise<void> {
    const transactionKeys = await sheets.readColumns(TRANSACTIONS_TAB, 1);
    const allocationKeys = await sheets.readColumns(ALLOCATIONS_TAB, 1);
    const writes: CellWrite[] = [];

    /**
     * 一張分頁上該清掉的列號。
     *
     * 兩種殭屍列：來源已經不在 SQLite 的 id，以及同一個 id 的重複列——定位表指向
     * 最後一列（引擎是後寫獲勝），較早那幾列再也不會被覆寫。
     */
    const ghostRowsOf = (
      keys: readonly (readonly string[])[],
      knownIds: ReadonlySet<string>,
    ): number[] => {
      const lastRowOf = new Map<string, number>();
      for (let i = 1; i < keys.length; i += 1) {
        const key = keys[i]?.[0] ?? "";
        if (MIRROR_ID.test(key)) lastRowOf.set(key, i + 1);
      }
      const rows: number[] = [];
      for (let i = 1; i < keys.length; i += 1) {
        const key = keys[i]?.[0] ?? "";
        // 不是 UUID 形狀就不是鏡像寫的：使用者貼的資料、寫給自己的備註，以及
        // 已經被清空的列（空字串）都走這條，一律原封不動。
        if (!MIRROR_ID.test(key)) continue;
        const rowIndex = i + 1;
        if (knownIds.has(key) && lastRowOf.get(key) === rowIndex) continue;
        rows.push(rowIndex);
      }
      return rows;
    };

    for (const rowIndex of ghostRowsOf(transactionKeys, known.transactions)) {
      writes.push({
        tab: TRANSACTIONS_TAB,
        rowIndex,
        cells: blankRow(TRANSACTIONS_HEADER.length),
      });
    }
    // 配置列同一套判準。掛在現有交易底下、但配置已經不存在的列由 buildWrites 清掉，
    // 校正會處理到每一筆交易，所以兩者合起來覆蓋了全部情形。
    for (const rowIndex of ghostRowsOf(allocationKeys, known.allocations)) {
      writes.push({
        tab: ALLOCATIONS_TAB,
        rowIndex,
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
    const maxPages = mode === "reconcile" ? (reconcileMaxPages ?? RECONCILE_MAX_PAGES) : 1;

    const months = new Set<string>();
    // 校正撈到的所有 id。走完全表才代表它是完整的，才能拿來判斷殭屍列。
    const knownTransactionIds = new Set<string>();
    const knownAllocationIds = new Set<string>();
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
        for (const txn of changed) {
          knownTransactionIds.add(txn.transactionId);
          for (const allocation of txn.allocations) knownAllocationIds.add(allocation.allocationId);
        }
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

      // 帳本是空的（advanced 全程沒被設過）就直接回 idle——清理與 lastReconciledAt
      // 都不會走到。刻意如此：空帳本上清殭屍列的價值極低，不值得為它多繞一條路徑，
      // 不是漏寫。
      if (advanced === null) return { kind: "idle" };

      if (mode === "reconcile" && scannedToEnd)
        await clearGhostRows({
          transactions: knownTransactionIds,
          allocations: knownAllocationIds,
        });

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
      // 失敗：游標與時間戳全部照抄舊狀態，只加計數、換 lastError。cursor 不動
      // 是設計核心——失敗仍推進游標，那批變更就被永久跳過而沒人發現。
      const failedState: SheetSyncState = {
        ...state,
        lastError: describeSheetFailure(error),
        consecutiveFailures: state.consecutiveFailures + 1,
      };
      await syncRepository.saveSyncState(failedState);
      // 達到門檻才升級：偶發的暫時性錯誤（下一輪 tick 就會自己好）不值得驚動人，
      // 連續失敗到一定次數才代表這不是暫時性的。
      if (failedState.consecutiveFailures >= ESCALATE_AFTER_FAILURES) {
        await notifyNeedsAttention(failedState);
      }
      return { kind: "failed", error };
    }
  }

  return {
    syncOnce: () => run("incremental"),
    reconcile: () => run("reconcile"),
  };
}
