import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";

import { logger } from "../logger.js";
import { LEDGER_COMMANDS } from "./commands.js";
import type { LedgerBotDependencies } from "./dependencies.js";
import { formatHelp } from "./format-help.js";
import { registerAdvanceHandlers } from "./handlers/advances.js";
import { registerDraftHandlers } from "./handlers/drafts.js";
import { registerPendingHandlers } from "./handlers/pending.js";
import { registerStatusHandlers } from "./handlers/status.js";
import { registerSummaryHandlers } from "./handlers/summaries.js";
import { registerTransactionHandlers } from "./handlers/transactions.js";
import { createAttentionNotifier } from "./notify-attention.js";
import { createOutboxRunner, type OutboxRunner } from "./outbox-runner.js";

export type { LedgerBotDependencies };
export { formatRecentPage } from "./handlers/transactions.js";

/**
 * createLedgerBot 的輸入：呼叫端不需要（也不該）自己組出 outboxRunner——它要用的
 * `bot.api` 得等 Bot 建好才存在。留一個選填的覆寫欄位只是為了讓測試能塞進一個
 * 用假 api 組出來、可以控制成功/失敗的 runner；正式環境（main.ts）一律用預設值。
 */
export type CreateLedgerBotOptions = Omit<LedgerBotDependencies, "outboxRunner"> & {
  readonly outboxRunner?: OutboxRunner;
};

export interface LedgerBot {
  readonly bot: Bot;
  /**
   * 背景遞送迴圈。建立時刻意不 start()——測試會不斷建立 bot，每個都掛一個
   * 真的 interval 只會添亂；何時開始輪詢是應用程式進入點（src/main.ts）的決定。
   */
  readonly outboxRunner: OutboxRunner;
}

// 只保留可以安全寫進正式環境日誌的欄位：更新種類不含任何內容，
// 更新編號是 Telegram 的流水號，不會洩漏使用者身分。
function describeUpdate(update: Update): string {
  if (update.callback_query) return "callback_query";
  if (update.message) return "message";
  return "other";
}

// Telegram 在新舊訊息內容與按鈕完全相同時會拒絕 editMessageText，回傳這個特定錯誤。
// 這不代表操作失敗——使用者的輸入通常已經生效，只是沒有東西可以重繪——所以要用
// error_code／description 精準辨識這一種錯誤，而不是對整段錯誤訊息做字串比對。
function isMessageNotModifiedError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    error.description.includes("message is not modified")
  );
}

export function createLedgerBot(dependencies: CreateLedgerBotOptions): LedgerBot {
  const bot = dependencies.botInfo
    ? new Bot(dependencies.token, { botInfo: dependencies.botInfo })
    : new Bot(dependencies.token);

  // 預設的遞送管道就是這顆 bot 自己的 api：sendMessage／editMessageText 借用
  // grammY 既有的 HTTP 呼叫，不必另外接一份 Telegram client。onNeedsAttention
  // 交給 createAttentionNotifier：一列放棄遞送時盡力發一則告警，同一條管道
  // 送不到就吞掉，不讓 drainOnce 整批中斷。
  const outboxRunner =
    dependencies.outboxRunner ??
    createOutboxRunner({
      repository: dependencies.repository,
      ownerId: dependencies.ownerId,
      now: dependencies.now,
      api: {
        sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
        editMessageText: (chatId, messageId, text, options) =>
          bot.api.editMessageText(chatId, messageId, text, options),
      },
      onNeedsAttention: createAttentionNotifier({
        repository: dependencies.repository,
        ownerId: dependencies.ownerId,
        now: dependencies.now,
        api: {
          sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text),
        },
      }),
    });
  const fullDependencies: LedgerBotDependencies = { ...dependencies, outboxRunner };

  // grammy 預設在沒有錯誤處理器時會停止輪詢，任何 handler 的例外都會讓整個 Bot 從此失聯。
  // 這裡把錯誤收斂成「這次操作失敗」，輪詢必須繼續。
  bot.catch(async (error) => {
    // 「訊息未變更」是良性結果：使用者的操作通常已經生效（例如逐人追問時第一筆
    // 代墊已經填好對象），只是下一輪的重繪內容剛好與上一則訊息逐字相同，
    // Telegram 因此拒絕更新。這不是「這次操作失敗」，不能用同一套錯誤處理，
    // 否則使用者會被一則無關的「操作失敗，請稍後再試」誤導。
    if (isMessageNotModifiedError(error.error)) {
      // 這不是錯誤，只是良性的跳過，所以用 info 而非 error 層級記錄。
      logger.info("Ledger Bot skipped a no-op message edit", {
        updateId: error.ctx.update.update_id,
        updateKind: describeUpdate(error.ctx.update),
      });
      return;
    }

    // 原始 error 物件交給 logger 內部的 describeError 處理，這裡不再自己拆解，
    // 才不會有兩份判斷邏輯各自演化、彼此不一致。
    logger.error("Ledger Bot handler failed", {
      updateId: error.ctx.update.update_id,
      updateKind: describeUpdate(error.ctx.update),
      error: error.error,
    });
    // 回答 callback query 讓 Telegram 端停止轉圈；這個回覆本身失敗也不能再往外拋，
    // 否則錯誤處理器的例外會繞過 grammy 的保護，重新讓 Bot 停止。
    if (error.ctx.callbackQuery) {
      try {
        await error.ctx.answerCallbackQuery({ text: "操作失敗，請稍後再試" });
      } catch {
        logger.error("Ledger Bot could not answer a failed callback query", {
          updateId: error.ctx.update.update_id,
        });
      }
    }
  });

  bot.use(async (context, next) => {
    const isOwner = context.from && String(context.from.id) === dependencies.ownerId;
    const isPrivate = context.chat?.type === "private";
    if (!isOwner || !isPrivate) {
      return;
    }
    await next();
  });

  registerTransactionHandlers(bot, fullDependencies);
  registerSummaryHandlers(bot, fullDependencies);
  registerPendingHandlers(bot, fullDependencies);
  registerAdvanceHandlers(bot, fullDependencies);
  // 必須排在 registerDraftHandlers 之前：drafts.ts 用 bot.on("message:text") 接住所有
  // 文字訊息當成草稿輸入、不呼叫 next()，晚註冊的話 /status、/help 永遠輪不到，會被
  // 誤判成「無法解析這筆輸入」。tests/telegram/help-command.test.ts 的清單測試會走過
  // LEDGER_COMMANDS 逐一驗證這件事，不必再靠這則註解提醒下一個新增的指令。
  registerStatusHandlers(bot, fullDependencies);
  bot.command("help", async (context) => {
    await context.reply(formatHelp());
  });
  registerDraftHandlers(bot, fullDependencies);

  return { bot, outboxRunner };
}

/**
 * 向 Telegram 註冊「/」選單裡的指令清單（`setMyCommands`）。
 *
 * 刻意不放進 createLedgerBot：那是一次網路呼叫，而 createLedgerBot 在測試裡被
 * 建構數百次——每次都順便打一次 setMyCommands 沒有意義，也會讓「測試建構 bot」
 * 跟「應用程式真正上線」這兩件事混在一起。真正呼叫的地方是 src/main.ts，
 * 在 LEDGER_STARTUP_CHECK 探測之後、真正開始輪詢（bot.start()）之前。
 */
export async function startBot(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([...LEDGER_COMMANDS]);
}
