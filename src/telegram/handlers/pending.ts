import type { Bot, Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";

import { listPending, type PendingPage } from "../../application/list-pending.js";
import { loadReferenceSnapshot } from "../../application/reference-data.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { decodeCallback, encodeCallback } from "../callback-data.js";
import { formatPreview } from "../format-preview.js";
import { formatPrompt } from "../format-prompt.js";

const groupTitles = {
  awaiting_input: "待補充",
  awaiting_confirmation: "待確認",
} as const;

function groupLines(page: PendingPage): string[] {
  if (page.items.length === 0) return [];
  const heading =
    page.totalPages > 1
      ? `${groupTitles[page.status]}（${String(page.page + 1)} / ${String(page.totalPages)}）`
      : groupTitles[page.status];
  return [
    heading,
    ...page.items.map(
      (item) =>
        `· ${item.draftRef} ${item.occurredDate} ${item.amount ?? "待補金額"} ${item.rawSegment}`,
    ),
  ];
}

function groupKeyboard(page: PendingPage): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = page.items.map((item) => [
    { text: `重新預覽 ${item.draftRef}`, callback_data: encodeCallback({ kind: "pending-open", draftRef: item.draftRef }) },
    { text: "封存", callback_data: encodeCallback({ kind: "archive", draftRef: item.draftRef }) },
  ]);
  if (page.totalPages > 1) {
    const status = page.status === "awaiting_input" ? "input" : "confirm";
    const navigation: InlineKeyboardButton[] = [
      ...(page.page > 0
        ? [
            {
              text: "上一頁",
              callback_data: encodeCallback({ kind: "pending-page", status, page: page.page - 1 }),
            },
          ]
        : []),
      ...(page.page < page.totalPages - 1
        ? [
            {
              text: "下一頁",
              callback_data: encodeCallback({ kind: "pending-page", status, page: page.page + 1 }),
            },
          ]
        : []),
    ];
    if (navigation.length > 0) rows.push(navigation);
  }
  return rows;
}

async function replyWithPending(
  context: Context,
  dependencies: LedgerBotDependencies,
  inputPage: number,
  confirmPage: number,
): Promise<void> {
  const input = await listPending(
    dependencies.repository,
    dependencies.ownerId,
    "awaiting_input",
    inputPage,
  );
  const confirm = await listPending(
    dependencies.repository,
    dependencies.ownerId,
    "awaiting_confirmation",
    confirmPage,
  );
  const lines = [...groupLines(input), ...groupLines(confirm)];
  if (lines.length === 0) {
    await context.reply("目前沒有待處理項目。");
    return;
  }
  await context.reply(lines.join("\n"), {
    reply_markup: { inline_keyboard: [...groupKeyboard(input), ...groupKeyboard(confirm)] },
  });
}

export function registerPendingHandlers(bot: Bot, dependencies: LedgerBotDependencies): void {
  bot.command("pending", async (context) => {
    await replyWithPending(context, dependencies, 0, 0);
  });

  bot.callbackQuery(/^[opz]:/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (!action) {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }

    if (action.kind === "pending-page") {
      await context.answerCallbackQuery();
      const isInput = action.status === "input";
      await replyWithPending(
        context,
        dependencies,
        isInput ? action.page : 0,
        isInput ? 0 : action.page,
      );
      return;
    }

    const record = await dependencies.repository.getDraftRecord({
      ownerId: dependencies.ownerId,
      draftRef: action.draftRef,
    });
    if (!record) {
      await context.answerCallbackQuery({ text: "草稿不存在" });
      return;
    }

    if (action.kind === "archive") {
      await dependencies.repository.archiveDraft(record.draftId);
      await context.answerCallbackQuery({ text: "已封存" });
      return;
    }

    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const message = record.incomplete
      ? formatPrompt(record.incomplete, record.draftRef, references)
      : record.draft
        ? formatPreview(record.draft, references)
        : null;
    if (!message) {
      await context.answerCallbackQuery({ text: "草稿無法重新預覽" });
      return;
    }
    await context.answerCallbackQuery();
    const sent = await context.reply(message.text, {
      ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
    });
    await dependencies.repository.setPreviewMessage(
      record.draftId,
      String(sent.chat.id),
      String(sent.message_id),
    );
  });
}
