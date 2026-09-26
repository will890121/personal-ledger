import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";

import type { LedgerBotDependencies } from "./dependencies.js";
import { registerAdvanceHandlers } from "./handlers/advances.js";
import { registerDraftHandlers } from "./handlers/drafts.js";
import { registerPendingHandlers } from "./handlers/pending.js";
import { registerSummaryHandlers } from "./handlers/summaries.js";
import { registerTransactionHandlers } from "./handlers/transactions.js";

export type { LedgerBotDependencies };
export { formatRecentPage } from "./handlers/transactions.js";

// 只保留可以安全寫進正式環境日誌的欄位：更新種類不含任何內容，
// 更新編號是 Telegram 的流水號，不會洩漏使用者身分。
function describeUpdate(update: Update): string {
  if (update.callback_query) return "callback_query";
  if (update.message) return "message";
  return "other";
}

// 錯誤訊息可能夾帶 SQL 片段（SqliteError）或使用者輸入的財務原文（ZodError 會回填實際值），
// 因此預設只記錄錯誤類別名稱；只有本專案自己以固定字串丟出的 Error 才連訊息一起記錄。
// GrammyError 是例外：error_code 與 description 是 Telegram Bot API 回傳的錯誤描述
// （例如 "Bad Request: message is not modified"），不含使用者輸入或財務資料，
// 記錄它們才診斷得出是哪一種 Telegram 呼叫失敗，而不是只看到一個籠統的類別名稱。
function describeError(error: unknown): {
  readonly name: string;
  readonly message?: string;
  readonly errorCode?: number;
  readonly description?: string;
} {
  if (error instanceof GrammyError) {
    return { name: error.name, errorCode: error.error_code, description: error.description };
  }
  if (!(error instanceof Error)) return { name: "UnknownError" };
  if (error.name === "Error") return { name: error.name, message: error.message };
  return { name: error.name };
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

export function createLedgerBot(dependencies: LedgerBotDependencies): Bot {
  const bot = dependencies.botInfo
    ? new Bot(dependencies.token, { botInfo: dependencies.botInfo })
    : new Bot(dependencies.token);

  // grammy 預設在沒有錯誤處理器時會停止輪詢，任何 handler 的例外都會讓整個 Bot 從此失聯。
  // 這裡把錯誤收斂成「這次操作失敗」，輪詢必須繼續。
  bot.catch(async (error) => {
    // 「訊息未變更」是良性結果：使用者的操作通常已經生效（例如逐人追問時第一筆
    // 代墊已經填好對象），只是下一輪的重繪內容剛好與上一則訊息逐字相同，
    // Telegram 因此拒絕更新。這不是「這次操作失敗」，不能用同一套錯誤處理，
    // 否則使用者會被一則無關的「操作失敗，請稍後再試」誤導。
    if (isMessageNotModifiedError(error.error)) {
      console.debug("Ledger Bot skipped a no-op message edit", {
        updateId: error.ctx.update.update_id,
        updateKind: describeUpdate(error.ctx.update),
      });
      return;
    }

    console.error("Ledger Bot handler failed", {
      updateId: error.ctx.update.update_id,
      updateKind: describeUpdate(error.ctx.update),
      ...describeError(error.error),
    });
    // 回答 callback query 讓 Telegram 端停止轉圈；這個回覆本身失敗也不能再往外拋，
    // 否則錯誤處理器的例外會繞過 grammy 的保護，重新讓 Bot 停止。
    if (error.ctx.callbackQuery) {
      try {
        await error.ctx.answerCallbackQuery({ text: "操作失敗，請稍後再試" });
      } catch {
        console.error("Ledger Bot could not answer a failed callback query", {
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

  registerTransactionHandlers(bot, dependencies);
  registerSummaryHandlers(bot, dependencies);
  registerPendingHandlers(bot, dependencies);
  registerAdvanceHandlers(bot, dependencies);
  registerDraftHandlers(bot, dependencies);

  return bot;
}
