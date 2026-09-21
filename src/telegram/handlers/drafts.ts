import type { Bot } from "grammy";

import type { Context } from "grammy";

import { cancelDraft, confirmDraft } from "../../application/confirm-draft.js";
import { createBatch, type CreateBatchResult } from "../../application/create-batch.js";
import { loadReferenceSnapshot } from "../../application/reference-data.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { formatPreview } from "../format-preview.js";
import { formatBatchSummary, formatPrompt } from "../format-prompt.js";

async function handleBatchResult(
  context: Context,
  result: CreateBatchResult,
  dependencies: LedgerBotDependencies,
): Promise<void> {
  if (result.kind === "duplicate") {
    await context.reply("此更新已處理。");
    return;
  }
  if (result.kind === "too_many_segments") {
    await context.reply("一次最多 10 筆，請分次輸入。");
    return;
  }
  if (result.kind === "empty") return;

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    dependencies.ownerId,
  );

  for (const item of result.items) {
    if (item.outcome.kind === "unparsed") continue;
    const message =
      item.outcome.kind === "draft"
        ? formatPreview(item.outcome.draft, references)
        : formatPrompt(item.outcome.draft, item.outcome.draftRef, references);
    const sent = await context.reply(message.text, {
      ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
    });
    // 預覽訊息 ID 是 reply 路由的唯一依據，必須在送出後立刻回寫。
    await dependencies.repository.setPreviewMessage(
      item.outcome.draft.draftId,
      String(sent.chat.id),
      String(sent.message_id),
    );
  }

  if (result.items.length > 1) {
    await context.reply(formatBatchSummary(result.items));
    return;
  }

  if (result.items.every((item) => item.outcome.kind === "unparsed")) {
    await context.reply("無法解析這筆輸入。例如：午餐 120、薪水 +85000、台新轉國泰 5000。");
  }
}

export function registerDraftHandlers(bot: Bot, dependencies: LedgerBotDependencies): void {
  bot.callbackQuery(/^confirm:/, async (context) => {
    const draftId = context.callbackQuery.data.slice("confirm:".length);
    const transaction = await confirmDraft(
      dependencies.repository,
      draftId,
      dependencies.now().toISOString(),
      dependencies.generateId(),
    );
    await context.answerCallbackQuery({ text: "已確認" });
    await context.editMessageText(
      `已入帳：${transaction.amount.currency} ${transaction.amount.amount}\n交易 ID：${transaction.transactionId}`,
    );
  });

  bot.callbackQuery(/^cancel:/, async (context) => {
    const draftId = context.callbackQuery.data.slice("cancel:".length);
    await cancelDraft(dependencies.repository, draftId);
    await context.answerCallbackQuery({ text: "已取消" });
    await context.editMessageText("草稿已取消。");
  });

  bot.on("message:text", async (context) => {
    const result = await createBatch(
      {
        ownerId: dependencies.ownerId,
        telegramUpdateId: String(context.update.update_id),
        sourceRef: `${String(context.chat.id)}:${String(context.message.message_id)}`,
        text: context.message.text,
        receivedAt: dependencies.now().toISOString(),
        occurredDate: dependencies.today(),
      },
      {
        repository: dependencies.repository,
        referenceRepository: dependencies.referenceRepository,
        generateId: dependencies.generateId,
      },
    );

    await handleBatchResult(context, result, dependencies);
  });
}
