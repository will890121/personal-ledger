import type { Bot } from "grammy";

import type { LedgerBotDependencies } from "../dependencies.js";
import { formatStatus } from "../format-status.js";
import type { DraftPrompt } from "../format-prompt.js";

async function renderStatus(dependencies: LedgerBotDependencies): Promise<DraftPrompt> {
  const summary = await dependencies.repository.summarizeOutbox(dependencies.ownerId);
  return formatStatus(summary, dependencies.schemaVersion, dependencies.now());
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
  bot.callbackQuery("outbox-retry", async (context) => {
    await dependencies.repository.retryOutboxNeedsAttention(
      dependencies.ownerId,
      dependencies.now().toISOString(),
    );
    await dependencies.outboxRunner.drainOnce();
    await context.answerCallbackQuery();
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
