import { Bot } from "grammy";
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
function describeError(error: unknown): { readonly name: string; readonly message?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  if (error.name === "Error") return { name: error.name, message: error.message };
  return { name: error.name };
}

export function createLedgerBot(dependencies: LedgerBotDependencies): Bot {
  const bot = dependencies.botInfo
    ? new Bot(dependencies.token, { botInfo: dependencies.botInfo })
    : new Bot(dependencies.token);

  // grammy 預設在沒有錯誤處理器時會停止輪詢，任何 handler 的例外都會讓整個 Bot 從此失聯。
  // 這裡把錯誤收斂成「這次操作失敗」，輪詢必須繼續。
  bot.catch(async (error) => {
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
