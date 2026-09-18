import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import { cancelDraft, confirmDraft } from "../application/confirm-draft.js";
import { createDraft } from "../application/create-draft.js";
import { listRecent } from "../application/list-recent.js";
import type { ConfirmedTransaction } from "../domain/ledger.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";
import { formatPreview } from "./format-preview.js";

export interface LedgerBotDependencies {
  readonly token: string;
  readonly ownerId: string;
  readonly repository: LedgerRepository;
  readonly referenceRepository: ReferenceRepository;
  readonly generateId: () => string;
  readonly now: () => Date;
  readonly today: () => string;
  readonly botInfo?: UserFromGetMe;
}

function formatRecent(transactions: readonly ConfirmedTransaction[]): string {
  if (transactions.length === 0) {
    return "尚無已確認交易。";
  }
  return transactions
    .map(
      (transaction) =>
        `${transaction.occurredDate} · ${transaction.amount.currency} ${transaction.amount.amount}`,
    )
    .join("\n");
}

export function createLedgerBot(dependencies: LedgerBotDependencies): Bot {
  const bot = dependencies.botInfo
    ? new Bot(dependencies.token, { botInfo: dependencies.botInfo })
    : new Bot(dependencies.token);

  bot.use(async (context, next) => {
    const isOwner = context.from && String(context.from.id) === dependencies.ownerId;
    const isPrivate = context.chat?.type === "private";
    if (!isOwner || !isPrivate) {
      return;
    }
    await next();
  });

  bot.command("recent", async (context) => {
    const transactions = await listRecent(dependencies.repository, dependencies.ownerId);
    await context.reply(formatRecent(transactions));
  });

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

    const preview = formatPreview(result.draft);
    await context.reply(preview.text, { reply_markup: preview.replyMarkup });
  });

  return bot;
}
