import type { Bot } from "grammy";

import type { Context } from "grammy";

import { cancelDraft, confirmDraft } from "../../application/confirm-draft.js";
import { answerDraft, type AnswerValue } from "../../application/answer-draft.js";
import { createBatch, type CreateBatchResult } from "../../application/create-batch.js";
import { listPending } from "../../application/list-pending.js";
import { loadReferenceSnapshot, type ReferenceSnapshot } from "../../application/reference-data.js";
import { recordRecovery } from "../../application/record-recovery.js";
import { IncompleteDraftSchema, type ParseField } from "../../domain/draft.js";
import type { TransactionDraft } from "../../domain/ledger.js";
import type { DraftRecord } from "../../ports/ledger-repository.js";
import { createHash } from "node:crypto";

import { normalizeReferenceName } from "../../domain/reference-data.js";
import { extractResidualKeyword } from "../../parser/residual-text.js";
import { parseRepayment } from "../../parser/split-share.js";
import { decodeCallback, encodeCallback } from "../callback-data.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { formatPreview } from "../format-preview.js";
import {
  formatBatchSummary,
  formatKeywordOffer,
  formatKeywordList,
  formatPrompt,
} from "../format-prompt.js";
import { deliverRecoveryResult, handleRecoveryReply, loadIncomeCategoryIds } from "./advances.js";

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
    if (result.kind === "draft" && field === "category") {
      await offerKeyword(context, result.draft, record.draftRef, references);
    }
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

/**
 * 分類補完之後，若句子裡還有一個解析器交代不出來的詞，提議把它記成使用者自訂關鍵字。
 * 只在這個時點提議：草稿此時已經完整，誤判時按「不用」不影響任何已完成的事。
 */
async function offerKeyword(
  context: Context,
  draft: TransactionDraft,
  draftRef: string,
  references: ReferenceSnapshot,
): Promise<void> {
  // rawInputSnapshot 是選填的：沒有原句就無從推導候選詞，靜靜跳過即可。
  if (!draft.rawInputSnapshot) return;
  const keyword = extractResidualKeyword(draft.rawInputSnapshot, references);
  if (!keyword) return;
  const categoryId = draft.allocations[0]?.categoryId;
  const categoryName = references.categories.find((item) => item.categoryId === categoryId)?.name;
  if (!categoryName) return;
  const offer = formatKeywordOffer(keyword, categoryName, draftRef);
  await context.reply(offer.text, {
    ...(offer.replyMarkup ? { reply_markup: offer.replyMarkup } : {}),
  });
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

/**
 * 打字直接輸入的回收語句（「小明還 300」「收到小明 300」）：必須排在純數字
 * 攔截之後、createBatch 之前嘗試，且對象名稱要與交易對象完全相符才觸發，
 * 否則「小明還欠我錢」這類一般敘述、或「午餐 120」這類一般支出，都可能被
 * 誤判或搶走輸入。parseRepayment 找不到相符對象時回傳 null，此時放行給
 * createBatch 當成一般交易解析。
 *
 * 回傳 true 代表這則訊息已被本函式處理完畢，呼叫端不應該再往下走。
 */
async function tryRecordRecoveryFromText(
  context: Context,
  dependencies: LedgerBotDependencies,
): Promise<boolean> {
  const counterparties = await dependencies.referenceRepository.listActiveCounterparties(
    dependencies.ownerId,
  );
  const repayment = parseRepayment(context.message?.text ?? "", counterparties);
  if (!repayment) return false;

  const result = await recordRecovery(
    {
      ownerId: dependencies.ownerId,
      counterpartyId: repayment.counterpartyId,
      received: repayment.amount,
      occurredDate: dependencies.today(),
      telegramUpdateId: String(context.update.update_id),
      sourceRef: `${String(context.chat?.id ?? "")}:${String(context.message?.message_id ?? "")}`,
      rawText: context.message?.text ?? "",
      receivedAt: dependencies.now().toISOString(),
    },
    {
      repository: dependencies.repository,
      generateId: dependencies.generateId,
      incomeCategoryIds: await loadIncomeCategoryIds(dependencies),
    },
  );

  await deliverRecoveryResult(context, result, dependencies);
  return true;
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
    const chatId = String(context.chat?.id ?? "");
    const targetMessageId = String(context.callbackQuery.message?.message_id ?? "");
    // 代墊回收草稿（record-recovery.ts 產生）與一般交易草稿走的是同一顆「確認」鍵、
    // 同一個 confirmDraft，差別只在於帳本變更的「原因」——這裡沒有另一條獨立的
    // repository 寫入路徑可以區分，唯一看得出來的信號就是配置本身的 purpose。
    const isRecovery = record.draft.allocations.some((item) => item.purpose === "advance_recovery");
    await confirmDraft(
      dependencies.repository,
      draftId,
      dependencies.now().toISOString(),
      dependencies.generateId(),
      {
        messageId: dependencies.generateId(),
        cause: isRecovery ? "recovery_recorded" : "transaction_confirmed",
        // 在 repository 的 transaction 內被呼叫：transactionId 這時才存在。
        render: (confirmed) => ({
          chatId,
          targetMessageId,
          text: isRecovery
            ? `已記錄代墊回收：${confirmed.amount.currency} ${confirmed.amount.amount}`
            : `已入帳：${confirmed.amount.currency} ${confirmed.amount.amount}\n交易 ID：${confirmed.transactionId}`,
        }),
      },
    );
    await context.answerCallbackQuery({ text: "已確認" });
    // 提交後立刻嘗試遞送，使用者體感與先前相同；失敗就留給背景迴圈補送。
    // 這裡不直接 editMessageText：訊息一律由 runner 送出，否則「已送出」與
    // outbox 狀態會有兩個真相來源，而且 runner 稍後還會再送一次。
    await dependencies.outboxRunner.drainOnce();
  });

  const KEYWORDS_MESSAGE_KEY = "keywords_list_message";

  /**
   * 由關鍵字本身導出的 8 碼短碼，供 callback_data 使用（關鍵字是中文，不能直接放）。
   * 與 shortAdvanceRef 同一套：確定性雜湊，同一個詞永遠得到同一個短碼，重新整理清單
   * 不會漂移，而且不會像清單索引那樣「位置還在、意義變了」。
   */
  function keywordRef(keyword: string): string {
    return createHash("sha256").update(normalizeReferenceName(keyword)).digest("hex").slice(0, 8);
  }

  /**
   * 關掉上一份關鍵字清單。與 /pending、/advances 同樣的理由：留著舊清單不只是佔位置，
   * 它的刪除鍵仍然可以按下去。Telegram 只允許刪除 48 小時內的訊息，刪不掉就安靜略過。
   */
  async function closePreviousKeywordList(context: Context): Promise<void> {
    const stored = await dependencies.repository.getSetting(
      dependencies.ownerId,
      KEYWORDS_MESSAGE_KEY,
    );
    if (!stored) return;
    const [chatId, messageId] = stored.split(":");
    if (chatId && messageId) {
      try {
        await context.api.deleteMessage(Number(chatId), Number(messageId));
      } catch {
        // 已被手動刪除或超過刪除期限，忽略。
      }
    }
    await dependencies.repository.clearSetting(dependencies.ownerId, KEYWORDS_MESSAGE_KEY);
  }

  /**
   * 教過的詞清單。這是「教錯了」唯一的出路：教過的詞會先於任何追問被命中，所以那個詞
   * 再也不會跳出「要記住嗎」，沒有這份清單，一次誤觸就會讓之後每一筆含該詞的交易被
   * 歸錯分類。刪除鍵帶的是清單索引而不是關鍵字本身——關鍵字是中文，不能放進
   * callback_data。
   */
  async function replyKeywordList(context: Context): Promise<void> {
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const items = references.userKeywords.map((item) => ({
      keyword: item.keyword,
      ref: keywordRef(item.keyword),
      categoryName:
        references.categories.find((category) => category.categoryId === item.categoryId)?.name ??
        "（分類已不存在）",
    }));
    const message = formatKeywordList(items);
    await closePreviousKeywordList(context);
    const sent = await context.reply(message.text, {
      ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
    });
    await dependencies.repository.setSetting(
      dependencies.ownerId,
      KEYWORDS_MESSAGE_KEY,
      `${String(sent.chat.id)}:${String(sent.message_id)}`,
    );
  }

  bot.command("keywords", async (context) => {
    await replyKeywordList(context);
  });

  bot.callbackQuery("dismiss-keywords", async (context) => {
    await context.answerCallbackQuery();
    await context.deleteMessage();
    await dependencies.repository.clearSetting(dependencies.ownerId, KEYWORDS_MESSAGE_KEY);
  });

  bot.callbackQuery(/^kd:/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (action?.kind !== "delete-keyword") {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    // 短碼由關鍵字本身導出，所以永遠指向同一個詞；指不到就是那個詞已經不在了。
    const keywords = await dependencies.referenceRepository.listUserCategoryKeywords(
      dependencies.ownerId,
    );
    const target = keywords.find((item) => keywordRef(item.keyword) === action.ref);
    if (!target) {
      await context.answerCallbackQuery({ text: "這個詞已經不在清單裡" });
      await replyKeywordList(context);
      return;
    }
    await dependencies.referenceRepository.deleteUserCategoryKeyword(
      dependencies.ownerId,
      target.keyword,
    );
    await context.answerCallbackQuery({ text: "已刪除" });
    await context.editMessageText(`已刪除「${target.keyword}」，之後這個詞會重新追問分類。`);
  });

  // 「要記住這個詞嗎」的回答。記住時從草稿重新推導候選詞與已選分類，因此不必為了這段
  // 對話在草稿上多存欄位；使用者若在這之前改過分類，記住的也會是他最後選的那一個。
  bot.callbackQuery(/^k:/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (action?.kind !== "teach-keyword") {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    if (!action.remember) {
      await context.answerCallbackQuery();
      await context.editMessageText("好，這次不記。");
      return;
    }
    const record = await dependencies.repository.getDraftRecord({
      ownerId: dependencies.ownerId,
      draftRef: action.draftRef,
    });
    const draft = record?.draft;
    const rawText = draft?.rawInputSnapshot;
    const categoryId = draft?.allocations[0]?.categoryId;
    if (!rawText || !categoryId) {
      await context.answerCallbackQuery({ text: "草稿不存在或已處理" });
      return;
    }
    const references = await loadReferenceSnapshot(
      dependencies.referenceRepository,
      dependencies.ownerId,
    );
    const keyword = extractResidualKeyword(rawText, references);
    const categoryName = references.categories.find((item) => item.categoryId === categoryId)?.name;
    if (!keyword && categoryName) {
      // 記住之後那個詞就成了已知詞，重新推導必定是 undefined。連按兩次很常見（網路慢、
      // 訊息沒即時更新），這時回「無法記住」等於對著一件已經做好的事報錯。
      const already = references.userKeywords.find(
        (item) => rawText.includes(item.keyword) && item.categoryId === categoryId,
      );
      if (already) {
        await context.answerCallbackQuery({ text: "已記住" });
        await context.editMessageText(`好，之後看到「${already.keyword}」就記成${categoryName}。`);
        return;
      }
    }
    if (!keyword || !categoryName) {
      await context.answerCallbackQuery({ text: "這個詞已經無法記住" });
      return;
    }
    await dependencies.referenceRepository.saveUserCategoryKeyword({
      ownerId: dependencies.ownerId,
      keyword,
      categoryId,
    });
    await context.answerCallbackQuery({ text: "已記住" });
    await context.editMessageText(`好，之後看到「${keyword}」就記成${categoryName}。`);
  });

  // 追問訊息上的取消鍵。預覽用的是舊的 `cancel:<draftId>`（draftId 是 UUID），追問手上
  // 只有 8 碼 draftRef，因此走 `x:<draftRef>` 這條。
  bot.callbackQuery(/^x:/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (action?.kind !== "cancel") {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    const record = await dependencies.repository.getDraftRecord({
      ownerId: dependencies.ownerId,
      draftRef: action.draftRef,
    });
    if (!record) {
      await context.answerCallbackQuery({ text: "草稿不存在或已處理" });
      return;
    }
    // 追問中的草稿是 IncompleteDraft，cancelDraft 會以 TransactionDraftSchema 解析既有
    // JSON，對它必定丟「draft not found」。放棄一筆未完成草稿在 M3a 已經定義為封存
    // （/pending 的「封存」鍵走的就是這條），這裡沿用同一個操作，不另立一個語意重複的
    // 狀態；對使用者而言兩者都是「這筆不再出現在待處理清單」。
    if (record.incomplete) {
      await dependencies.repository.archiveDraft(record.draftId);
    } else {
      await cancelDraft(dependencies.repository, record.draftId);
    }
    await context.answerCallbackQuery({ text: "已取消" });
    await context.editMessageText("草稿已取消。");
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
      // 代墊回收金額的回覆必須綁定「收到多少？」那則發問訊息，並且排在
      // 草稿回覆與下面的純數字攔截之前處理，否則會被那條規則劫走。
      if (await handleRecoveryReply(context, dependencies)) return;

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

    if (await tryRecordRecoveryFromText(context, dependencies)) return;

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
