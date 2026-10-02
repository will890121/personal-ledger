import type { Bot } from "grammy";

import type { LedgerBotDependencies, SheetsMirrorStatusDependencies } from "../dependencies.js";
import { formatStatus, type SheetsStatusView } from "../format-status.js";
import type { DraftPrompt } from "../format-prompt.js";

/**
 * 「落後幾筆」的查詢上限：比任何正常情況下真的會發生的落後量都大得多
 * （正常情況下每 20 秒就會同步掉，落後量幾乎永遠是個位數）。撞到這個上限
 * 就代表狀況已經嚴重到不需要精確數字，只需要知道「很多」，所以畫面上印成
 * 「5000+ 筆」而不是耗費一次可能昂貴的全表查詢去算出精確值。
 */
const BACKLOG_QUERY_LIMIT = 5000;

/**
 * 讀出 /status 的 Sheets 區段要顯示的原始資料。`null` 代表鏡像整個關閉
 * （config.sheets 為 null），這裡不做任何格式化——時區換算留給 formatStatus。
 */
async function loadSheetsStatus(
  sheetsMirror: SheetsMirrorStatusDependencies | null,
  ownerId: string,
): Promise<SheetsStatusView | null> {
  if (sheetsMirror === null) return null;

  const state = await sheetsMirror.syncRepository.loadSyncState(ownerId);
  const cursor =
    state.cursorUpdatedAt !== null && state.cursorTransactionId !== null
      ? { updatedAt: state.cursorUpdatedAt, transactionId: state.cursorTransactionId }
      : null;
  const changed = await sheetsMirror.syncRepository.listChangedTransactions(
    ownerId,
    cursor,
    BACKLOG_QUERY_LIMIT,
  );

  return {
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    lastReconciledAt: state.lastReconciledAt,
    backlog: changed.length,
    backlogAtLimit: changed.length === BACKLOG_QUERY_LIMIT,
  };
}

async function renderStatus(dependencies: LedgerBotDependencies): Promise<DraftPrompt> {
  const summary = await dependencies.repository.summarizeOutbox(dependencies.ownerId);
  const sheets = await loadSheetsStatus(dependencies.sheetsMirror, dependencies.ownerId);
  return formatStatus(
    summary,
    dependencies.schemaVersion,
    dependencies.now(),
    dependencies.timeOfDay,
    dependencies.dateOf,
    sheets,
  );
}

export function registerStatusHandlers(bot: Bot, dependencies: LedgerBotDependencies): void {
  bot.command("status", async (context) => {
    const view = await renderStatus(dependencies);
    await context.reply(view.text, {
      ...(view.replyMarkup ? { reply_markup: view.replyMarkup } : {}),
    });
  });

  // 放棄遞送之後唯一的回頭路：把 needs_attention 全部丟回 pending 並歸零 attempts，
  // 立刻 drainOnce() 一次讓使用者馬上看到結果，而不是等下一輪背景輪詢。
  //
  // answerCallbackQuery() 必須排在 drainOnce() 之前（本分支另外四個會觸發 outbox 的
  // handler 也都是這個順序）：drain 最多是 10 次循序的 Telegram 呼叫，而「重試全部」
  // 存在的唯一理由就是 Telegram 半通不通——那正是這 10 次呼叫最容易超過 callback
  // 約 15 秒回答窗口的時候。按鈕一直轉圈、最後回一句「操作失敗」，但重試其實已經做了。
  bot.callbackQuery("outbox-retry", async (context) => {
    await dependencies.repository.retryOutboxNeedsAttention(
      dependencies.ownerId,
      dependencies.now().toISOString(),
    );
    await context.answerCallbackQuery();
    await dependencies.outboxRunner.drainOnce();
    const view = await renderStatus(dependencies);
    await context.editMessageText(view.text, {
      ...(view.replyMarkup ? { reply_markup: view.replyMarkup } : {}),
    });
  });
}
