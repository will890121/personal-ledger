import type { Transformer } from "grammy";
import type { Update } from "grammy/types";

import { createLedgerBot } from "../../src/telegram/create-bot.js";
import type { SheetsMirrorStatusDependencies } from "../../src/telegram/dependencies.js";
import { SCHEMA_VERSION } from "../../src/db/migrate.js";
import { summarizeAllocations } from "../../src/domain/ledger-summary.js";
import type { MirrorTransaction, SheetSyncState } from "../../src/ports/sheet-sync-repository.js";
import { dateInTimezone, timeOfDayInTimezone } from "../../src/timezone.js";
import { FakeLedgerRepository } from "./fake-ledger-repository.js";
import { FakeReferenceRepository } from "./fake-reference-repository.js";

/** 一筆用來墊 listChangedTransactions 回傳數量的假交易，內容不重要——只用來算長度。 */
function fillerTransaction(index: number): MirrorTransaction {
  return {
    transactionId: `sheet-backlog-${String(index)}`,
    occurredDate: "2026-09-18",
    occurredTime: null,
    amount: "0",
    accountFromName: null,
    accountToName: null,
    merchantName: null,
    counterpartyName: null,
    note: null,
    rawInputSnapshot: null,
    status: "confirmed",
    confirmedAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    allocations: [],
  };
}

export interface HarnessSheetsMirrorOptions {
  readonly state?: Partial<SheetSyncState>;
  /** 模擬 listChangedTransactions 回傳的筆數，用來驗證「落後」欄位。 */
  readonly changedCount?: number;
}

/**
 * 組出 /status Sheets 區段用的假依賴。只有 status-command.test.ts 需要真的區分
 * 「啟用」與「關閉」，其餘測試一律不傳 `sheetsMirror`、維持關閉，行為不變。
 */
function buildFakeSheetsMirror(
  options: HarnessSheetsMirrorOptions,
): SheetsMirrorStatusDependencies {
  const state: SheetSyncState = {
    ownerId: "123",
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastReconciledAt: null,
    ...options.state,
  };
  const changed = Array.from({ length: options.changedCount ?? 0 }, (_, index) =>
    fillerTransaction(index),
  );
  return {
    syncRepository: {
      loadSyncState: () => Promise.resolve(state),
      listChangedTransactions: (_ownerId, _cursor, limit) =>
        Promise.resolve(changed.slice(0, limit)),
    },
  };
}

export interface ApiCall {
  readonly method: string;
  readonly payload: unknown;
}

export function getText(call: ApiCall | undefined): string | undefined {
  if (!call || typeof call.payload !== "object" || call.payload === null) return undefined;
  if (!("text" in call.payload) || typeof call.payload.text !== "string") return undefined;
  return call.payload.text;
}

export function sentMessages(calls: readonly ApiCall[]): ApiCall[] {
  return calls.filter((call) => call.method === "sendMessage");
}

export function lastSentMessageId(calls: readonly ApiCall[]): number {
  return sentMessages(calls).length;
}

export function firstDraftRef(repository: FakeLedgerRepository): string {
  const record = [...repository.records.values()][0];
  if (!record) throw new Error("no draft recorded");
  return record.draftRef;
}

export interface HarnessOptions {
  readonly today?: string;
  /**
   * 時鐘取值函式而非固定 Date：outbox 的退避重試需要看到時間真的往前走，
   * 測試才能在「第一次送失敗」與「之後補送」之間推進時鐘。
   */
  readonly now?: () => Date;
  /** 模擬 Telegram 拒絕刪除訊息（例如超過 48 小時）。 */
  readonly failDeleteMessage?: boolean;
  /**
   * 模擬 Telegram 送出/編輯訊息失敗（網路中斷、逾時之類），供 outbox 重試相關測試
   * 使用。回傳的 `deliveryControl` 讓測試在流程中途切換，不必重建整個 harness。
   */
  readonly failDelivery?: boolean;
  /**
   * /status 的 Sheets 區段用。省略（`undefined`）代表鏡像關閉——大多數測試不關心
   * Sheets，維持這個預設值才不必逐一改寫既有測試。傳物件（即使是 `{}`）代表
   * 鏡像啟用，欄位預設是「從未同步過」的零狀態。
   */
  readonly sheetsMirror?: HarnessSheetsMirrorOptions;
}

/** 讓測試在草稿確認之後，切換「Telegram 是否還連得上」。 */
export interface DeliveryControl {
  failing: boolean;
}

export function createHarness(options: HarnessOptions = {}) {
  const repository = new FakeLedgerRepository();
  const referenceRepository = new FakeReferenceRepository();
  const calls: ApiCall[] = [];
  const deliveryControl: DeliveryControl = { failing: options.failDelivery ?? false };
  let nextId = 0;
  let nextMessageId = 0;
  const { bot, outboxRunner } = createLedgerBot({
    token: "123456:test-token",
    ownerId: "123",
    repository,
    referenceRepository,
    summaryRepository: { summarize: () => Promise.resolve(summarizeAllocations([])) },
    generateId: () => `id-${String(++nextId)}`,
    now: options.now ?? (() => new Date("2026-09-18T01:00:00.000Z")),
    today: () => options.today ?? "2026-09-18",
    // 固定用 Asia/Taipei：正式環境設定的就是這個時區，/status 的時區測試需要一個
    // 真的與 UTC 有偏移的時區，才能把「忘記轉時區、直接印 UTC」這種退步抓出來。
    timeOfDay: (at) => timeOfDayInTimezone(at, "Asia/Taipei"),
    dateOf: (at) => dateInTimezone(at, "Asia/Taipei"),
    sheetsMirror:
      options.sheetsMirror === undefined ? null : buildFakeSheetsMirror(options.sheetsMirror),
    schemaVersion: SCHEMA_VERSION,
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Ledger Bot",
      username: "ledger_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  const capture: Transformer = (_previous, method, payload) => {
    calls.push({ method, payload });
    // outbox runner 遞送訊息也是走 bot.api（sendMessage／editMessageText），
    // 在這裡攔下來才能模擬「訊息記了帳但送不出去」而不影響其他呼叫
    // （例如 answerCallbackQuery 仍應該成功，使用者的按鈕才不會一直轉圈）。
    if (deliveryControl.failing && (method === "sendMessage" || method === "editMessageText")) {
      return Promise.reject(new Error("Telegram delivery unavailable"));
    }
    if (method === "deleteMessage" && options.failDeleteMessage === true) {
      return Promise.reject(new Error("message can't be deleted"));
    }
    if (method === "sendMessage") {
      nextMessageId += 1;
      return Promise.resolve({
        ok: true,
        result: {
          message_id: nextMessageId,
          date: 1_758_157_200,
          chat: { id: 123, type: "private", first_name: "Owner" },
        },
      } as never);
    }
    return Promise.resolve({ ok: true, result: true } as never);
  };
  bot.api.config.use(capture);
  return { bot, calls, repository, referenceRepository, runner: outboxRunner, deliveryControl };
}

export function messageUpdate(options: {
  updateId: number;
  userId?: number;
  chatType?: "private" | "group";
  text: string;
  replyToMessageId?: number;
}): Update {
  const userId = options.userId ?? 123;
  const chatType = options.chatType ?? "private";
  const chat =
    chatType === "private"
      ? { id: userId, type: "private" as const, first_name: "Owner" }
      : { id: -100, type: "group" as const, title: "Ledger Test Group" };
  // Telegram 的 reply_to_message 型別是遞迴的，測試替身不需要完整建模，
  // 因此在這裡做一次結構斷言。
  const update = {
    update_id: options.updateId,
    message: {
      message_id: options.updateId,
      date: 1_758_157_200,
      chat,
      from: { id: userId, is_bot: false as const, first_name: "Owner" },
      text: options.text,
      ...(options.replyToMessageId !== undefined
        ? {
            reply_to_message: {
              message_id: options.replyToMessageId,
              date: 1_758_157_200,
              chat,
            },
          }
        : {}),
      ...(options.text.startsWith("/")
        ? { entities: [{ type: "bot_command" as const, offset: 0, length: options.text.length }] }
        : {}),
    },
  };
  return update as unknown as Update;
}

export function replyUpdate(options: {
  updateId: number;
  text: string;
  replyToMessageId: number;
}): Update {
  return messageUpdate(options);
}

export function callbackUpdate(options: { updateId: number; data: string }): Update {
  return {
    update_id: options.updateId,
    callback_query: {
      id: `callback-${String(options.updateId)}`,
      chat_instance: "instance-1",
      from: { id: 123, is_bot: false as const, first_name: "Owner" },
      data: options.data,
      message: {
        message_id: 10,
        date: 1_758_157_200,
        chat: { id: 123, type: "private" as const, first_name: "Owner" },
        text: "preview",
      },
    },
  };
}
