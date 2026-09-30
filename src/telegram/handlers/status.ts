import type { Bot } from "grammy";

import type { LedgerBotDependencies } from "../dependencies.js";
import { formatStatus } from "../format-status.js";
import type { DraftPrompt } from "../format-prompt.js";

async function renderStatus(dependencies: LedgerBotDependencies): Promise<DraftPrompt> {
  const summary = await dependencies.repository.summarizeOutbox(dependencies.ownerId);
  return formatStatus(
    summary,
    dependencies.schemaVersion,
    dependencies.now(),
    dependencies.timeOfDay,
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

  bot.callbackQuery("dismiss-status", async (context) => {
    await context.answerCallbackQuery();
    await context.deleteMessage();
  });
}
