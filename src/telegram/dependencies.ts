import type { UserFromGetMe } from "grammy/types";

import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";
import type { SheetSyncRepository } from "../ports/sheet-sync-repository.js";
import type { SummaryRepository } from "../ports/summary-repository.js";
import type { OutboxRunner } from "./outbox-runner.js";

/**
 * /status 顯示 Sheets 鏡像狀態用的最小介面：只收窄成讀狀態與查變更兩個方法，
 * 不需要 `saveSyncState`／`loadAlertAt`／`saveAlertAt`——/status 只讀不寫。
 */
export interface SheetsMirrorStatusDependencies {
  readonly syncRepository: Pick<SheetSyncRepository, "loadSyncState" | "listChangedTransactions">;
}

export interface LedgerBotDependencies {
  readonly token: string;
  readonly ownerId: string;
  readonly repository: LedgerRepository;
  readonly referenceRepository: ReferenceRepository;
  readonly summaryRepository: SummaryRepository;
  readonly generateId: () => string;
  readonly now: () => Date;
  readonly today: () => string;
  /**
   * /status 顯示「幾點幾分」用；由呼叫端（main.ts／測試 harness）依設定的時區算出，
   * 這一層本身不知道時區是什麼，只負責把時刻交給它。
   */
  readonly timeOfDay: (at: Date) => string;
  /**
   * /status 顯示「最後完整校正時間」用；跟 `timeOfDay` 同樣由呼叫端依設定時區
   * 算出。這個時間戳可能是好幾天前——只印時分的話，昨天校正過跟上星期校正過
   * 會印出一模一樣的字串，正好蓋掉「校正已經停住好幾天」這個唯一的訊號
   * （見 src/sheets/sheet-mirror.ts 對 RECONCILE_MAX_PAGES 截斷的說明），
   * 所以這裡另外要日期。
   */
  readonly dateOf: (at: Date) => string;
  /**
   * /status 顯示 Sheets 鏡像狀態用。`null` 代表這台機器沒有 Sheets 憑證
   * （config.sheets 為 null）——鏡像整個關閉，/status 要印「未啟用」，
   * 不能印空白或一排 0（那會被誤讀成「鏡像開著但一直失敗」）。
   */
  readonly sheetsMirror: SheetsMirrorStatusDependencies | null;
  readonly botInfo?: UserFromGetMe;
  /**
   * 確認之後真正把訊息送出去的那個 runner；handler 只負責 enqueue 與提交後立刻
   * drainOnce() 一次，不自己呼叫 editMessageText。由 createLedgerBot 建立，
   * 這裡只是宣告 handler 看得到的形狀。
   */
  readonly outboxRunner: OutboxRunner;
  /** /status 顯示用；由呼叫端（main.ts／測試 harness）從 src/db/migrate.ts 的 SCHEMA_VERSION 帶入。 */
  readonly schemaVersion: number;
}
