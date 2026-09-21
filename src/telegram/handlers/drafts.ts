import type { Bot } from "grammy";

import { cancelDraft, confirmDraft } from "../../application/confirm-draft.js";
import { createDraft } from "../../application/create-draft.js";
import { loadReferenceSnapshot } from "../../application/reference-data.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { formatPreview } from "../format-preview.js";

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
    const result = await createDraft(
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

    if (result.kind === "duplicate") {
      await context.reply("此更新已處理。");
      return;
    }
    if (result.kind === "missing_fields") {
      await context.reply("缺少必要欄位：金額。");
      return;
    }
    if (result.kind === "ambiguous") {
      await context.reply("找到多個符合的參照資料，請提供更完整的名稱。");
      return;
    }

    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const preview = formatPreview(result.draft, references);
    await context.reply(preview.text, { reply_markup: preview.replyMarkup });
  });
}
