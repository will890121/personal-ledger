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
   * 記錄失敗用。刻意收窄成單一函式簽章：tick 只需要「有人記一行錯誤」這個能力，
   * 記到哪裡是呼叫端的事。正式組裝（main.ts）會把 logger.error 傳進來，測試則用
   * 一個 vi.fn() 替身——兩邊的函式簽章相容。
   *
   * 訂正：這段註解原本寫「logger.ts import 了 grammY，而 src/sheets/ 不能依賴
   * grammY」。前半句不成立——`src/logger.ts` 從來沒有 import 過 grammY（判斷
   * GrammyError 的是 src/telegram/delivery-error.ts），同一個目錄下的
   * sheet-mirror.ts 也一直都直接 import logger。邊界規則本身是真的，現在由
   * eslint.config.mjs 的 no-restricted-imports zone 把關（src/sheets/ 與
   * src/logger.ts 都不得 import grammY），不再只是註解裡的一句宣稱。
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
 * 而且今天（同樣依設定時區）既沒有校正**完成**、也沒有校正**嘗試**過。
 *
 * 為什麼要分成兩個條件：`lastReconciledAt` 只在校正真的掃完全表（`scannedToEnd`）
 * 時才蓋——那是 `/status` 誠實的基礎，被 RECONCILE_MAX_PAGES 截斷的一輪不能
 * 算成功。但拿同一個時間戳當排程條件就會鎖死：截斷的校正不蓋時間戳，下一個
 * tick 於是又判定該校正，再截斷、再不蓋……20 秒一輪永遠重複，增量同步整天
 * 一次都輪不到。實測 10 次 syncNow()：reconcile 10 次、syncOnce 0 次、
 * 時間戳十輪都沒前進。門檻是帳本超過 RECONCILE_MAX_PAGES × SYNC_BATCH＝兩萬筆，
 * 而校正從最舊的一筆開始分頁，所以被截斷時最新的帳永遠掃不到——使用者從 04:00
 * 到午夜記的帳完全不會上試算表，而且不會自己恢復（AC-22 在此狀態下不成立）。
 *
 * 兩個條件都要看，不是換掉：`attemptedDate` 活在行程內（見
 * `createSheetMirrorRunner` 的說明），重啟後是空的；若只看它，正式環境每次
 * 重啟都會無條件再校正一次，連「今天已經完整校正過」也照跑。
 *
 * 日期與時數一律經 `src/timezone.ts` 換算，不自己用 UTC 小時或 `Date` 的
 * 本地方法算——host 容器的系統時區不保證是使用者設定的 TZ，八小時的時差會讓
 * 這裡在錯的時刻觸發、或者永遠不觸發。M4 已經為 `/status` 裁決過同一條規則，
 * 這裡援用。
 */
function shouldReconcileToday(
  lastReconciledAt: string | null,
  attemptedDate: string | null,
  now: Date,
  timezone: string,
): boolean {
  const currentHour = Number(timeOfDayInTimezone(now, timezone).slice(0, 2));
  if (currentHour < RECONCILE_HOUR) return false;
  const today = dateInTimezone(now, timezone);
  if (attemptedDate === today) return false;
  if (lastReconciledAt === null) return true;
  return dateInTimezone(new Date(lastReconciledAt), timezone) !== today;
}

export function createSheetMirrorRunner(deps: SheetMirrorRunnerDependencies): SheetMirrorRunner {
  let timer: ReturnType<typeof setInterval> | null = null;
  // 節流／防重疊的核心：校正單次呼叫內部會自己分頁掃完整張表（最多
  // RECONCILE_MAX_PAGES 頁），耗時可能遠超過 SYNC_INTERVAL_MS 這 20 秒。
  // 沒有這個旗標，下一輪 timer 一樣會在 20 秒後觸發，於是同一個 owner 同時有
  // 兩個校正（或一個校正疊一個增量）在跑，各自對 Sheets 開一輪 API 呼叫——
  // 配額瞬間翻倍，兩邊還可能同時寫同一張表。寧可晚一輪，不要疊加。
  let inFlight = false;
  /**
   * 「今天已經**嘗試**過校正」的標記（設定時區下的 `YYYY-MM-DD`），只給排程判斷用。
   *
   * 刻意**不**持久化，也刻意不去動 `lastReconciledAt` 的語意（那是 `/status`
   * 對使用者說「上次校正完成於」的依據，只有真的掃完全表才算）。存哪裡的三個
   * 選項都可行，選行程內狀態的理由：
   *   - 這是純排程用的判斷，不是帳本事實。放進 `sheet_sync_state` 要多一個
   *     migration 與一個永久欄位，放進 `settings` 表則是第二個時間戳、第二次
   *     寫入——而「兩個時間戳各自寫、各自可能不同步」正好是本分支一再付錢
   *     找出來的那一類缺陷。排程狀態放在排程器裡，只有一個地方能改它。
   *   - 代價說清楚：重啟後標記是空的，於是每次行程啟動當天會多嘗試一次校正
   *     （大帳本上約 400 次 API 呼叫，之後的 tick 就回到增量）。比起修好之前的
   *     「每 20 秒一輪、整天不做增量」，這個代價是有界的；而且 `/status` 與
   *     `sqlite3` 都看不到這個標記，事後要問「今天為什麼沒校正」只能翻日誌
   *     （截斷本身有 logger.warn 可循）。
   */
  let reconcileAttemptedDate: string | null = null;

  async function syncTick(): Promise<SyncOutcome> {
    const state = await deps.syncRepository.loadSyncState(deps.ownerId);
    const reconcileDue = shouldReconcileToday(
      state.lastReconciledAt,
      reconcileAttemptedDate,
      deps.now(),
      deps.timezone,
    );
    if (!reconcileDue) return deps.mirror.syncOnce();

    const outcome = await deps.mirror.reconcile();
    // 只要校正真的跑完一輪（含被 RECONCILE_MAX_PAGES 截斷的那種：outcome 是
    // `synced` 但 `scannedToEnd` 為 false），今天就算試過了，接下來的 tick 回去
    // 跑增量。失敗（`failed`）不算試過——那條路上游標與時間戳全部照舊、告警另有
    // 機制，維持現在「下一個 tick 用平常的規則重試」的行為。
    if (outcome.kind !== "failed") {
      reconcileAttemptedDate = dateInTimezone(deps.now(), deps.timezone);
    }
    return outcome;
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
