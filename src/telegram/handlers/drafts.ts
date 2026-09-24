import type { Bot } from "grammy";

import type { Context } from "grammy";

import { cancelDraft, confirmDraft } from "../../application/confirm-draft.js";
import { answerDraft, type AnswerValue } from "../../application/answer-draft.js";
import { createBatch, type CreateBatchResult } from "../../application/create-batch.js";
import { listPending } from "../../application/list-pending.js";
import { loadReferenceSnapshot } from "../../application/reference-data.js";
import { IncompleteDraftSchema, type ParseField } from "../../domain/draft.js";
import type { DraftRecord } from "../../ports/ledger-repository.js";
import { decodeCallback, encodeCallback } from "../callback-data.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { formatPreview } from "../format-preview.js";
import { formatBatchSummary, formatPrompt } from "../format-prompt.js";

const AMOUNT_ONLY = /^\d+(?:\.\d+)?$/;

async function applyAnswer(
  context: Context,
  record: DraftRecord,
  field: ParseField,
  value: AnswerValue,
  dependencies: LedgerBotDependencies,
): Promise<void> {
  const result = await answerDraft(
    {
      ownerId: dependencies.ownerId,
      draftId: record.draftId,
      field,
      value,
      telegramUpdateId: String(context.update.update_id),
      sourceRef: context.callbackQuery
        ? context.callbackQuery.id
        : `${String(context.chat?.id ?? "")}:${String(context.message?.message_id ?? "")}`,
      rawText: value.kind === "amount" ? value.text : value.label,
      receivedAt: dependencies.now().toISOString(),
    },
    { repository: dependencies.repository, generateId: dependencies.generateId },
  );

  if (result.kind === "invalid") {
    await context.reply(
      result.reason === "amount_not_numeric"
        ? "金額格式無法辨識，請輸入數字。"
        : "這筆草稿已無法補欄位。",
    );
    return;
  }

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    dependencies.ownerId,
  );
  const message =
    result.kind === "draft"
      ? formatPreview(result.draft, references)
      : formatPrompt(result.draft, record.draftRef, references);

  // 由候選按鈕觸發時，就地改寫那則追問訊息；它已經是草稿登記的預覽訊息，
  // 不必也不該再多留一則帶著舊按鈕的訊息。
  if (context.callbackQuery) {
    await context.editMessageText(message.text, {
      ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
    });
    return;
  }

  const sent = await context.reply(message.text, {
    ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
  });
  await dependencies.repository.setPreviewMessage(
    record.draftId,
    String(sent.chat.id),
    String(sent.message_id),
  );
}

// 交易對象的文字回覆不是「答案本身」，而是「想建立的名字」：先把它記成
// proposedName 並重新追問確認，等使用者按下建立才真正落成 counterpartyId，
// 避免打字誤觸就直接建立一個對象。
async function proposeCounterparty(
  context: Context,
  record: DraftRecord,
  proposedName: string,
  dependencies: LedgerBotDependencies,
): Promise<void> {
  if (!record.incomplete) return;
  const trimmed = proposedName.trim();
  if (trimmed.length === 0) {
    await context.reply("交易對象名稱不能是空白，請重新輸入。");
    return;
  }

  const pendingFields = record.incomplete.pendingFields.map((item) =>
    item.field === "counterparty" ? { ...item, proposedName: trimmed } : item,
  );
  const updated = IncompleteDraftSchema.parse({ ...record.incomplete, pendingFields });
  await dependencies.repository.replaceDraft(record.draftId, updated);

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    dependencies.ownerId,
  );
  const message = formatPrompt(updated, record.draftRef, references);
  const sent = await context.reply(message.text, {
    ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
  });
  await dependencies.repository.setPreviewMessage(
    record.draftId,
    String(sent.chat.id),
    String(sent.message_id),
  );
}

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
    const record = await dependencies.repository.getDraftRecord({ draftId });
    if (!record?.draft) {
      await context.answerCallbackQuery({ text: "草稿不存在" });
      await context.editMessageReplyMarkup();
      return;
    }
    // 跨日草稿不直接入帳：舊訊息裡的按鈕可能在幾天後被誤觸，必須重新預覽並再確認一次。
    if (record.createdDate !== null && record.createdDate !== dependencies.today()) {
      await dependencies.repository.touchDraftDate(draftId, dependencies.today());
      const references = await loadReferenceSnapshot(
        dependencies.referenceRepository,
        dependencies.ownerId,
      );
      const preview = formatPreview(record.draft, references);
      await context.answerCallbackQuery({ text: "草稿已跨日，請重新確認" });
      // 就地取代舊預覽：留著它等於留下一顆已失效但仍可按的確認鍵。
      await context.editMessageText([`建立日期：${record.createdDate}`, preview.text].join("\n"), {
        reply_markup: preview.replyMarkup,
      });
      return;
    }
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
    const replyTo = context.message.reply_to_message;
    if (replyTo) {
      const record = await dependencies.repository.getDraftRecord({
        previewChatId: String(context.chat.id),
        previewMessageId: String(replyTo.message_id),
      });
      if (record?.incomplete) {
        const field = record.incomplete.pendingFields[0]?.field ?? "amount";
        if (field === "counterparty") {
          await proposeCounterparty(context, record, context.message.text, dependencies);
          return;
        }
        // amount 與 advanceShare 都是純數字追問，走同一條「金額」回答路徑；
        // patchFor 會依欄位分別套用到總額或每人負擔金額。
        await applyAnswer(
          context,
          record,
          field,
          { kind: "amount", text: context.message.text },
          dependencies,
        );
        return;
      }
    }

    // 純數字訊息必須在建立批次之前攔截：`120` 本身會被解析成一筆缺分類的草稿，
    // 若先建批次就永遠走不到候選清單，也會留下使用者沒有要的草稿。
    const trimmed = context.message.text.trim();
    if (AMOUNT_ONLY.test(trimmed)) {
      const pending = await listPending(
        dependencies.repository,
        dependencies.ownerId,
        "awaiting_input",
        0,
      );
      const awaitingAmount = pending.items.filter((item) => item.amount === null);
      if (awaitingAmount.length > 0) {
        await context.reply(`要把 ${trimmed} 填到哪一筆？`, {
          reply_markup: {
            inline_keyboard: awaitingAmount.map((item) => [
              {
                text: `${item.occurredDate} ${item.rawSegment}`,
                callback_data: encodeCallback({
                  kind: "apply-amount",
                  draftRef: item.draftRef,
                  amount: trimmed,
                }),
              },
            ]),
          },
        });
        return;
      }
    }

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

  bot.callbackQuery(/^[av]:/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (!action || (action.kind !== "answer" && action.kind !== "apply-amount")) {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    const record = await dependencies.repository.getDraftRecord({
      ownerId: dependencies.ownerId,
      draftRef: action.draftRef,
    });
    if (!record?.incomplete) {
      await context.answerCallbackQuery({ text: "草稿不存在或已處理" });
      return;
    }

    if (action.kind === "apply-amount") {
      await context.answerCallbackQuery();
      await applyAnswer(
        context,
        record,
        "amount",
        { kind: "amount", text: action.amount },
        dependencies,
      );
      return;
    }

    const pending = record.incomplete.pendingFields.find((item) => item.field === action.field);
    const candidateId = pending?.candidateIds[action.index];
    if (!candidateId) {
      await context.answerCallbackQuery({ text: "選項已失效" });
      return;
    }
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const label =
      references.categories.find((item) => item.categoryId === candidateId)?.name ??
      references.accounts.find((item) => item.accountId === candidateId)?.name ??
      references.counterparties.find((item) => item.counterpartyId === candidateId)?.name ??
      candidateId;
    await context.answerCallbackQuery();
    await applyAnswer(
      context,
      record,
      action.field,
      { kind: "reference", id: candidateId, label },
      dependencies,
    );
  });

  bot.callbackQuery(/^c:/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (!action || action.kind !== "create-counterparty") {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    const record = await dependencies.repository.getDraftRecord({
      ownerId: dependencies.ownerId,
      draftRef: action.draftRef,
    });
    if (!record?.incomplete) {
      await context.answerCallbackQuery({ text: "草稿不存在或已處理" });
      return;
    }
    const pending = record.incomplete.pendingFields.find((item) => item.field === "counterparty");
    if (!pending?.proposedName) {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }

    const counterparty = await dependencies.referenceRepository.upsertCounterparty({
      referenceId: dependencies.generateId(),
      ownerId: dependencies.ownerId,
      name: pending.proposedName,
    });
    await context.answerCallbackQuery();
    await applyAnswer(
      context,
      record,
      "counterparty",
      { kind: "reference", id: counterparty.counterpartyId, label: counterparty.name },
      dependencies,
    );
  });
}
