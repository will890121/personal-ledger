import type { UserFromGetMe } from "grammy/types";

import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";
import type { SummaryRepository } from "../ports/summary-repository.js";
import type { OutboxRunner } from "./outbox-runner.js";

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
