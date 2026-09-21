import type { Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import { cancelDraft, confirmDraft } from "../../application/confirm-draft.js";
import { listRecent } from "../../application/list-recent.js";
import { softDeleteConfirmedTransaction } from "../../application/mutate-transaction.js";
import { loadReferenceSnapshot } from "../../application/reference-data.js";
import type { ReferenceSnapshot } from "../../application/reference-data.js";
import type { ConfirmedTransaction } from "../../domain/ledger.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { formatPreview } from "../format-preview.js";

const recentPurposeLabels: Record<ConfirmedTransaction["allocations"][number]["purpose"], string> =
  {
    income: "收入",
    expense: "支出",
    transfer: "轉帳",
    refund: "退款",
    advance: "代墊",
    advance_recovery: "代墊收回",
    loan_out: "借出",
    loan_in: "借入",
    loan_repayment: "還款",
    fee: "手續費",
  };

export function formatRecentPage(
  transactions: readonly ConfirmedTransaction[],
  references: Partial<ReferenceSnapshot> = {},
  selectedTransactionId?: string,
): { readonly text: string; readonly replyMarkup?: InlineKeyboardMarkup } {
  if (transactions.length === 0) {
    return { text: "尚無已確認交易。" };
  }
  const requestedIndex = selectedTransactionId
    ? transactions.findIndex((item) => item.transactionId === selectedTransactionId)
    : 0;
  const index = requestedIndex >= 0 ? requestedIndex : 0;
  const transaction = transactions[index];
  if (!transaction) return { text: "尚無已確認交易。" };
  const accountFrom = references.accounts?.find(
    (item) => item.accountId === transaction.accountFromId,
  );
  const accountTo = references.accounts?.find((item) => item.accountId === transaction.accountToId);
  const merchant = references.merchants?.find((item) => item.merchantId === transaction.merchantId);
  const allocationLines = transaction.allocations.map((allocation, allocationIndex) => {
    const category = allocation.subcategory
      ? `${allocation.category}／${allocation.subcategory}`
      : allocation.category;
    return `配置 ${String(allocationIndex + 1)}：${recentPurposeLabels[allocation.purpose]}・${category} · ${allocation.amount.currency} ${allocation.amount.amount}`;
  });
  const referenceLines = [
    ...(merchant ? [`商家：${merchant.name}`] : []),
    ...(accountFrom && accountTo
      ? [`帳戶：${accountFrom.name} → ${accountTo.name}`]
      : accountFrom
        ? [`帳戶：${accountFrom.name}`]
        : []),
  ];
  const navigation = [
    ...(index > 0
      ? [
          {
            text: "上一筆",
            callback_data: `recent:${transactions[index - 1]?.transactionId ?? ""}`,
          },
        ]
      : []),
    ...(index < transactions.length - 1
      ? [
          {
            text: "下一筆",
            callback_data: `recent:${transactions[index + 1]?.transactionId ?? ""}`,
          },
        ]
      : []),
  ];
  return {
    text: [
      `交易 ${String(index + 1)} / ${String(transactions.length)}`,
      `日期：${transaction.occurredDate}`,
      `總金額：${transaction.amount.currency} ${transaction.amount.amount}`,
      ...referenceLines,
      ...allocationLines,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        ...(navigation.length ? [navigation] : []),
        [
          ...(transaction.allocations.some((item) => item.purpose === "expense")
            ? [{ text: "退款", callback_data: `refund:${transaction.transactionId}` }]
            : []),
          { text: "刪除", callback_data: `delete:${transaction.transactionId}` },
        ],
        [{ text: "關閉清單", callback_data: "dismiss-recent" }],
      ],
    },
  };
}

export function registerTransactionHandlers(bot: Bot, dependencies: LedgerBotDependencies): void {
  bot.command("recent", async (context) => {
    const transactions = await listRecent(dependencies.repository, dependencies.ownerId);
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const page = formatRecentPage(transactions, references);
    await context.reply(page.text, {
      ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
    });
  });

  bot.callbackQuery(/^recent:/, async (context) => {
    const transactionId = context.callbackQuery.data.slice("recent:".length);
    const transactions = await listRecent(dependencies.repository, dependencies.ownerId);
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const page = formatRecentPage(transactions, references, transactionId);
    await context.answerCallbackQuery();
    await context.editMessageText(page.text, {
      ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
    });
  });

  bot.callbackQuery("recent-home", async (context) => {
    const transactions = await listRecent(dependencies.repository, dependencies.ownerId);
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const page = formatRecentPage(transactions, references);
    await context.answerCallbackQuery();
    await context.editMessageText(page.text, {
      ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
    });
  });

  bot.callbackQuery("dismiss-recent", async (context) => {
    await context.answerCallbackQuery();
    await context.deleteMessage();
  });

  bot.callbackQuery(/^delete:/, async (context) => {
    const transactionId = context.callbackQuery.data.slice("delete:".length);
    const transaction = await dependencies.repository.getTransaction(
      dependencies.ownerId,
      transactionId,
    );
    if (!transaction || transaction.status === "deleted") {
      await context.answerCallbackQuery({ text: "交易不存在或已刪除" });
      return;
    }
    await context.answerCallbackQuery({ text: "請確認刪除" });
    await context.editMessageText(
      `確認刪除：${transaction.occurredDate} · ${transaction.amount.currency} ${transaction.amount.amount}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "確認刪除", callback_data: `delete-confirm:${transactionId}` },
              { text: "取消", callback_data: `delete-cancel:${transactionId}` },
            ],
          ],
        },
      },
    );
  });

  bot.callbackQuery(/^delete-cancel:/, async (context) => {
    const transactionId = context.callbackQuery.data.slice("delete-cancel:".length);
    const transactions = await listRecent(dependencies.repository, dependencies.ownerId);
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const page = formatRecentPage(transactions, references, transactionId);
    await context.answerCallbackQuery({ text: "已取消" });
    await context.editMessageText(page.text, {
      ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
    });
  });

  bot.callbackQuery(/^delete-confirm:/, async (context) => {
    const transactionId = context.callbackQuery.data.slice("delete-confirm:".length);
    const transaction = await dependencies.repository.getTransaction(
      dependencies.ownerId,
      transactionId,
    );
    if (!transaction || transaction.status === "deleted") {
      await context.answerCallbackQuery({ text: "交易不存在或已刪除" });
      return;
    }
    const changedAt = dependencies.now().toISOString();
    const eventId = dependencies.generateId();
    try {
      await softDeleteConfirmedTransaction(
        {
          ownerId: dependencies.ownerId,
          transactionId,
          sourceEventId: eventId,
          auditEventId: dependencies.generateId(),
          expectedUpdatedAt: transaction.updatedAt ?? transaction.confirmedAt,
          changedAt,
        },
        {
          repository: dependencies.repository,
          inputEvent: {
            eventId,
            ownerId: dependencies.ownerId,
            telegramUpdateId: String(context.update.update_id),
            sourceType: "telegram",
            sourceRef: context.callbackQuery.id,
            rawText: "delete transaction callback",
            receivedAt: changedAt,
          },
        },
      );
      await context.answerCallbackQuery({ text: "交易已刪除" });
      await context.editMessageText("交易已刪除。", {
        reply_markup: {
          inline_keyboard: [[{ text: "返回交易清單", callback_data: "recent-home" }]],
        },
      });
    } catch {
      await context.answerCallbackQuery({ text: "無法刪除交易" });
    }
  });

  bot.callbackQuery(/^refund:/, async (context) => {
    const transactionId = context.callbackQuery.data.slice("refund:".length);
    const transaction = await dependencies.repository.getTransaction(
      dependencies.ownerId,
      transactionId,
    );
    if (!transaction || transaction.status === "deleted") {
      await context.answerCallbackQuery({ text: "原交易不存在" });
      return;
    }
    const sourceEventId = dependencies.generateId();
    const recorded = await dependencies.repository.recordInputEvent({
      eventId: sourceEventId,
      ownerId: dependencies.ownerId,
      telegramUpdateId: String(context.update.update_id),
      sourceType: "telegram",
      sourceRef: context.callbackQuery.id,
      rawText: "refund transaction callback",
      receivedAt: dependencies.now().toISOString(),
    });
    if (!recorded.created) {
      await context.answerCallbackQuery({ text: "退款操作已處理" });
      return;
    }
    const originalAllocation = transaction.allocations.find((item) => item.purpose === "expense");
    if (!originalAllocation) {
      await context.answerCallbackQuery({ text: "此交易不可退款" });
      return;
    }
    const draft = {
      draftId: dependencies.generateId(),
      ownerId: dependencies.ownerId,
      requestId: dependencies.generateId(),
      sourceEventId,
      refundTargetTransactionId: transaction.transactionId,
      occurredDate: dependencies.today(),
      amount: transaction.amount,
      allocations: [
        {
          allocationId: dependencies.generateId(),
          fundsEffect: "inflow" as const,
          purpose: "refund" as const,
          amount: transaction.amount,
          ...(originalAllocation.categoryId ? { categoryId: originalAllocation.categoryId } : {}),
          category: originalAllocation.category,
          ...(originalAllocation.subcategory
            ? { subcategory: originalAllocation.subcategory }
            : {}),
        },
      ],
      status: "awaiting_confirmation" as const,
    };
    await dependencies.repository.saveDraft(draft);
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const preview = formatPreview(draft, { ...references, refundTarget: transaction });
    await context.answerCallbackQuery({ text: "請確認退款" });
    await context.editMessageText(preview.text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "確認退款", callback_data: `refund-confirm:${draft.draftId}` },
            { text: "取消", callback_data: `refund-cancel:${draft.draftId}` },
          ],
        ],
      },
    });
  });

  bot.callbackQuery(/^refund-confirm:/, async (context) => {
    const draftId = context.callbackQuery.data.slice("refund-confirm:".length);
    const transaction = await confirmDraft(
      dependencies.repository,
      draftId,
      dependencies.now().toISOString(),
      dependencies.generateId(),
    );
    await context.answerCallbackQuery({ text: "退款已入帳" });
    await context.editMessageText(
      `退款已入帳：${transaction.amount.currency} ${transaction.amount.amount}`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "返回交易清單", callback_data: "recent-home" }]],
        },
      },
    );
  });

  bot.callbackQuery(/^refund-cancel:/, async (context) => {
    const draftId = context.callbackQuery.data.slice("refund-cancel:".length);
    const draft = await dependencies.repository.getDraft(draftId);
    await cancelDraft(dependencies.repository, draftId);
    const transactions = await listRecent(dependencies.repository, dependencies.ownerId);
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const page = formatRecentPage(transactions, references, draft?.refundTargetTransactionId);
    await context.answerCallbackQuery({ text: "已取消退款" });
    await context.editMessageText(page.text, {
      ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
    });
  });
}
