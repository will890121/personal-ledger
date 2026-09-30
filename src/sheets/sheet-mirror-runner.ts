import { dateInTimezone, timeOfDayInTimezone } from "../timezone.js";
import type { SheetSyncRepository } from "../ports/sheet-sync-repository.js";
import type { SheetMirror, SyncOutcome } from "./sheet-mirror.js";

/**
 * 兩個 tick 之間的間隔。比照 outbox-runner.ts 的 DRAIN_INTERVAL_MS，同一個形狀。
 * 20 秒一次、每次「沒變更就不打 API」——這正是整個配額設計的基礎（spec §7）：
 * Sheets API 每使用者每分鐘只有 60 次寫入額度，這個 tick 頻率若無條件同步就會
 * 空轉逼近上限。
 */
export const SYNC_INTERVAL_MS = 20_000;

/** 每天校正的時刻（TZ 設定時區下的小時數，24 小時制）。 */
export const RECONCILE_HOUR = 4;

export interface SheetMirrorRunnerDependencies {
  readonly mirror: SheetMirror;
  /** 只需要讀狀態來判斷今天是否已經校正過，收窄成一個方法就好。 */
  readonly syncRepository: Pick<SheetSyncRepository, "loadSyncState">;
  readonly ownerId: string;
  /** 用來判斷「今天」與「幾點」的時區（沿用 config.ts 的 TZ）。 */
  readonly timezone: string;
  readonly now: () => Date;
  /**
   * 記錄失敗用。刻意收窄成單一函式簽章，不直接 import src/logger.ts：
   * logger.ts import 了 grammY（用來判斷 GrammyError），而 src/sheets/ 依邊界規則
   * 不能依賴 grammY（見本檔案的 AC 邊界）。正式組裝（main.ts）會把 logger.error
   * 傳進來，測試則用一個 vi.fn() 替身——兩邊的函式簽章相容。
   */
  readonly logError: (message: string, fields?: Record<string, unknown>) => void;
}

export interface SheetMirrorRunner {
  start(): void;
  stop(): void;
  /**
   * 跑一次 tick（判斷增量或校正、呼叫對應的引擎方法）。start() 排程的每一輪
   * timer 呼叫的就是這個方法，測試也直接呼叫它來驗證單輪行為。
   *
   * 若上一輪呼叫還沒結束就回傳 `undefined` 而不重疊執行——見下方 `inFlight` 的說明。
   */
  syncNow(): Promise<SyncOutcome | undefined>;
}

/**
 * 判斷這一輪該不該走校正：現在的時數（依設定時區）已經過了 RECONCILE_HOUR，
 * 而且今天（同樣依設定時區）還沒校正過。
 *
 * 日期與時數一律經 `src/timezone.ts` 換算，不自己用 UTC 小時或 `Date` 的
 * 本地方法算——host 容器的系統時區不保證是使用者設定的 TZ，八小時的時差會讓
 * 這裡在錯的時刻觸發、或者永遠不觸發。M4 已經為 `/status` 裁決過同一條規則，
 * 這裡援用。
 */
function shouldReconcileToday(
  lastReconciledAt: string | null,
  now: Date,
  timezone: string,
): boolean {
  const currentHour = Number(timeOfDayInTimezone(now, timezone).slice(0, 2));
  if (currentHour < RECONCILE_HOUR) return false;
  if (lastReconciledAt === null) return true;
  return dateInTimezone(new Date(lastReconciledAt), timezone) !== dateInTimezone(now, timezone);
}

export function createSheetMirrorRunner(deps: SheetMirrorRunnerDependencies): SheetMirrorRunner {
  let timer: ReturnType<typeof setInterval> | null = null;
  // 節流／防重疊的核心：校正單次呼叫內部會自己分頁掃完整張表（最多
  // RECONCILE_MAX_PAGES 頁），耗時可能遠超過 SYNC_INTERVAL_MS 這 20 秒。
  // 沒有這個旗標，下一輪 timer 一樣會在 20 秒後觸發，於是同一個 owner 同時有
  // 兩個校正（或一個校正疊一個增量）在跑，各自對 Sheets 開一輪 API 呼叫——
  // 配額瞬間翻倍，兩邊還可能同時寫同一張表。寧可晚一輪，不要疊加。
  let inFlight = false;

  async function syncTick(): Promise<SyncOutcome> {
    const state = await deps.syncRepository.loadSyncState(deps.ownerId);
    const reconcileDue = shouldReconcileToday(state.lastReconciledAt, deps.now(), deps.timezone);
    return reconcileDue ? deps.mirror.reconcile() : deps.mirror.syncOnce();
  }

  async function syncNow(): Promise<SyncOutcome | undefined> {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await syncTick();
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      // syncNow() 真的會 reject：loadSyncState、syncOnce、reconcile 都在 try 之外。
      // Node 24 預設 --unhandled-rejections=throw，少了這個 .catch()，一次 Sheets
      // API 錯誤就會直接殺掉整個行程，而 compose.yaml 是 restart: unless-stopped——
      // 每 20 秒死一次的無盡 crash loop（M4 的 C1 踩過同一個坑）。記一行就好，
      // 不 rethrow：下一輪 tick 會用平常的規則重新試。
      syncNow().catch((error: unknown) => {
        deps.logError("sheet mirror sync failed", { error });
      });
    }, SYNC_INTERVAL_MS);
    // 不 unref 的話，這個 timer 會讓行程永遠不結束——LEDGER_STARTUP_CHECK 探針
    // 與測試都會因此掛住（M4 踩過同一個坑）。
    timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, syncNow };
}
