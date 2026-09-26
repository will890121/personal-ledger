import { createHash } from "node:crypto";

import type { Bot, Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import { abandonAdvance } from "../../application/abandon-advance.js";
import { listAdvances, type CounterpartyAdvances } from "../../application/list-advances.js";
import { loadReferenceSnapshot } from "../../application/reference-data.js";
import { recordRecovery, type RecordRecoveryResult } from "../../application/record-recovery.js";
import { computeOutstanding } from "../../domain/advance.js";
import { decodeCallback } from "../callback-data.js";
import type { LedgerBotDependencies } from "../dependencies.js";
import { formatAdvances, type AdvanceRefs } from "../format-advance.js";
import { formatPreview } from "../format-preview.js";
import { formatRecoverySurplusPrompt } from "../format-recovery-prompt.js";

const ADVANCES_MESSAGE_KEY = "advances_list_message";
// 待回收狀態：綁定「發問訊息」的 chatId:messageId，只有回覆到那則訊息的純數字
// 才算是回收金額，否則會被 M3a 既有的純數字攔截（要填到哪一筆草稿）劫走。
const RECOVERY_PENDING_KEY = "advance_pending_recovery";
const REF_SETTING_PREFIX = "advance_ref:";
const AMOUNT_ONLY = /^\d+(?:\.\d+)?$/;

/**
 * 把交易對象 ID／配置 ID 轉成 8 碼短碼，供 callback_data 使用。
 * UUID 與中文名稱都不得進 callback_data：一來可能超過 64 bytes 上限，
 * 二來 UUID 本身沒有防竄改與長度保證。雜湊是確定性的，同一個 id 永遠得到
 * 同一個短碼，重新整理清單不會讓短碼漂移。
 */
export function shortAdvanceRef(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

async function persistRef(dependencies: LedgerBotDependencies, id: string): Promise<string> {
  const ref = shortAdvanceRef(id);
  await dependencies.repository.setSetting(dependencies.ownerId, `${REF_SETTING_PREFIX}${ref}`, id);
  return ref;
}

async function resolveRef(
  dependencies: LedgerBotDependencies,
  ref: string,
): Promise<string | null> {
  return dependencies.repository.getSetting(dependencies.ownerId, `${REF_SETTING_PREFIX}${ref}`);
}

async function buildRefs(
  dependencies: LedgerBotDependencies,
  groups: readonly CounterpartyAdvances[],
): Promise<AdvanceRefs> {
  const counterparty = new Map<string, string>();
  const allocation = new Map<string, string>();
  for (const group of groups) {
    counterparty.set(group.counterpartyId, await persistRef(dependencies, group.counterpartyId));
    for (const item of group.items) {
      allocation.set(item.allocationId, await persistRef(dependencies, item.allocationId));
    }
  }
  return { counterparty, allocation };
}

/**
 * 取得啟用中的收入葉分類 ID，供超額回收草稿的待補分類欄位使用。
 * Task 14 的文字入口（drafts.ts）沿用同一套，避免另外發明一份邏輯。
 */
export async function loadIncomeCategoryIds(
  dependencies: LedgerBotDependencies,
): Promise<string[]> {
  const categories = await dependencies.referenceRepository.listActiveCategories(
    dependencies.ownerId,
  );
  return categories
    .filter((item) => item.kind === "income" && item.depth === 2)
    .map((item) => item.categoryId);
}

async function findOutstandingByAllocationId(
  dependencies: LedgerBotDependencies,
  allocationId: string,
) {
  const [advanceRows, recoveryRows] = await Promise.all([
    dependencies.repository.listAdvanceRows(dependencies.ownerId),
    dependencies.repository.listRecoveryRows(dependencies.ownerId),
  ]);
  return computeOutstanding(advanceRows, recoveryRows).find(
    (item) => item.allocationId === allocationId,
  );
}

async function renderAdvances(
  dependencies: LedgerBotDependencies,
  page: number,
): Promise<{ text: string; replyMarkup?: InlineKeyboardMarkup }> {
  const groups = await listAdvances(
    dependencies.repository,
    dependencies.referenceRepository,
    dependencies.ownerId,
  );
  const refs = await buildRefs(dependencies, groups);
  return formatAdvances(groups, refs, page);
}

/**
 * 關掉上一份清單，做法比照 `handlers/pending.ts` 的 closePreviousList：
 * 留著舊清單會顯示過期內容，按鈕也仍可按下，是誤導與誤觸的來源；
 * Telegram 只允許刪除 48 小時內的訊息，刪不掉就安靜略過。
 */
async function closePreviousList(
  context: Context,
  dependencies: LedgerBotDependencies,
): Promise<void> {
  const stored = await dependencies.repository.getSetting(
    dependencies.ownerId,
    ADVANCES_MESSAGE_KEY,
  );
  if (!stored) return;
  const [chatId, messageId] = stored.split(":");
  if (!chatId || !messageId) return;
  try {
    await context.api.deleteMessage(Number(chatId), Number(messageId));
  } catch {
    // 舊清單已被手動刪除或超過刪除期限，忽略。
  }
  await dependencies.repository.clearSetting(dependencies.ownerId, ADVANCES_MESSAGE_KEY);
}

async function replyWithAdvances(
  context: Context,
  dependencies: LedgerBotDependencies,
  page: number,
): Promise<void> {
  await closePreviousList(context, dependencies);
  const view = await renderAdvances(dependencies, page);
  const sent = await context.reply(view.text, {
    ...(view.replyMarkup ? { reply_markup: view.replyMarkup } : {}),
  });
  await dependencies.repository.setSetting(
    dependencies.ownerId,
    ADVANCES_MESSAGE_KEY,
    `${String(sent.chat.id)}:${String(sent.message_id)}`,
  );
}

/**
 * 就地更新清單訊息。刻意在沒有鍵盤時明確清空 reply_markup：
 * editMessageText 若省略 reply_markup，Telegram 會保留舊鍵盤不動，
 * 放棄回收把最後一筆代墊清空後，若不清鍵盤，會留下一顆指向已不存在
 * 配置的「放棄回收」按鈕，按下去也只會得到「操作已失效」，屬誤觸來源。
 */
async function refreshAdvancesMessage(
  context: Context,
  dependencies: LedgerBotDependencies,
  page: number,
): Promise<void> {
  const view = await renderAdvances(dependencies, page);
  await context.editMessageText(view.text, {
    reply_markup: view.replyMarkup ?? { inline_keyboard: [] },
  });
}

/**
 * 處理「回覆代墊回收提問」的純數字輸入。必須在 `message:text` 的 reply
 * 路由階段、且排在 M3a 既有的純數字攔截之前呼叫：那條攔截規則會把任何
 * 純數字都拿去問「要填到哪一筆待補金額的草稿」，若本函式排在它之後，
 * 回收金額就會被劫走，使用者看到的是候選清單而不是回收預覽。
 *
 * 回傳 true 代表這則訊息已被本函式處理完畢，呼叫端不應該再往下走。
 */
export async function handleRecoveryReply(
  context: Context,
  dependencies: LedgerBotDependencies,
): Promise<boolean> {
  const message = context.message;
  const replyTo = message?.reply_to_message;
  if (!message || !replyTo) return false;

  const stored = await dependencies.repository.getSetting(
    dependencies.ownerId,
    RECOVERY_PENDING_KEY,
  );
  if (!stored) return false;
  const [chatId, messageId, ref] = stored.split(":");
  if (!chatId || !messageId || !ref) return false;
  if (chatId !== String(context.chat?.id ?? "") || messageId !== String(replyTo.message_id)) {
    // 回覆的不是那則「收到多少？」的提問訊息，不是回收金額的輸入。
    return false;
  }

  // 命中後立刻清除：不論後續金額格式是否有效，這把鑰匙都已經用掉，
  // 避免殘留的鍵在往後劫持任何回到同一則訊息的輸入。
  await dependencies.repository.clearSetting(dependencies.ownerId, RECOVERY_PENDING_KEY);

  const counterpartyId = await resolveRef(dependencies, ref);
  if (!counterpartyId) {
    await context.reply("這筆代墊對象已失效，請重新從 /advances 開始。");
    return true;
  }

  const trimmed = message.text?.trim() ?? "";
  if (!AMOUNT_ONLY.test(trimmed)) {
    // 上面已經把待回收的鍵清掉了，這則訊息不能邀請使用者「再輸入一次數字」——
    // 照著重試的數字會被當成一筆全新的支出，產生垃圾草稿。指引重新開始才是實話。
    await context.reply("金額格式無法辨識，請重新從 /advances 按「記錄收款」。");
    return true;
  }

  const result = await recordRecovery(
    {
      ownerId: dependencies.ownerId,
      counterpartyId,
      received: trimmed,
      occurredDate: dependencies.today(),
      telegramUpdateId: String(context.update.update_id),
      sourceRef: `${String(context.chat?.id ?? "")}:${String(message.message_id)}`,
      rawText: message.text ?? trimmed,
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

/**
 * 把 recordRecovery 的結果送回聊天室：重複輸入、查無未回收代墊、以及正常
 * 草稿／待補分類三種結果的呈現方式，在「回覆待回收提問」（本檔）與「打字
 * 直接輸入回收語句」（drafts.ts 的 message:text）兩條路徑共用，避免各自維護
 * 一份幾乎相同的渲染邏輯。
 */
export async function deliverRecoveryResult(
  context: Context,
  result: RecordRecoveryResult,
  dependencies: LedgerBotDependencies,
): Promise<void> {
  if (result.kind === "duplicate") {
    await context.reply("此更新已處理。");
    return;
  }
  if (result.kind === "no_outstanding") {
    await context.reply("這位交易對象目前沒有未回收代墊。");
    return;
  }

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    dependencies.ownerId,
  );
  const view =
    result.kind === "incomplete"
      ? formatRecoverySurplusPrompt(result, references)
      : formatPreview(result.draft, references);
  const sent = await context.reply(view.text, {
    ...(view.replyMarkup ? { reply_markup: view.replyMarkup } : {}),
  });
  await dependencies.repository.setPreviewMessage(
    result.draft.draftId,
    String(sent.chat.id),
    String(sent.message_id),
  );
}

export function registerAdvanceHandlers(bot: Bot, dependencies: LedgerBotDependencies): void {
  bot.command("advances", async (context) => {
    await replyWithAdvances(context, dependencies, 0);
  });

  bot.callbackQuery("dismiss-advances", async (context) => {
    await context.answerCallbackQuery();
    await context.deleteMessage();
    await dependencies.repository.clearSetting(dependencies.ownerId, ADVANCES_MESSAGE_KEY);
  });

  bot.callbackQuery(/^advances-page:/, async (context) => {
    const page = Number(context.callbackQuery.data.slice("advances-page:".length));
    await context.answerCallbackQuery();
    await refreshAdvancesMessage(context, dependencies, Number.isFinite(page) ? page : 0);
  });

  bot.callbackQuery("cancel-abandon", async (context) => {
    await context.answerCallbackQuery();
    await refreshAdvancesMessage(context, dependencies, 0);
  });

  bot.callbackQuery(/^aa-confirm:/, async (context) => {
    const ref = context.callbackQuery.data.slice("aa-confirm:".length);
    const allocationId = await resolveRef(dependencies, ref);
    if (!allocationId) {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    const result = await abandonAdvance(
      {
        ownerId: dependencies.ownerId,
        allocationId,
        telegramUpdateId: String(context.update.update_id),
        sourceRef: context.callbackQuery.id,
        receivedAt: dependencies.now().toISOString(),
      },
      {
        repository: dependencies.repository,
        generateId: dependencies.generateId,
        now: dependencies.now,
      },
    );
    if (result.kind === "not_found") {
      await context.answerCallbackQuery({ text: "交易不存在" });
      return;
    }
    if (result.kind === "nothing_to_abandon") {
      await context.answerCallbackQuery({ text: "此代墊已無餘額可放棄" });
      return;
    }
    await context.answerCallbackQuery({ text: `已放棄回收 ${result.amount}` });
    await refreshAdvancesMessage(context, dependencies, 0);
  });

  bot.callbackQuery(/^(ar|aa):/, async (context) => {
    const action = decodeCallback(context.callbackQuery.data);
    if (!action || (action.kind !== "advance-recover" && action.kind !== "advance-abandon")) {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }

    if (action.kind === "advance-recover") {
      const counterpartyId = await resolveRef(dependencies, action.ref);
      if (!counterpartyId) {
        await context.answerCallbackQuery({ text: "操作已失效" });
        return;
      }
      await context.answerCallbackQuery();
      const sent = await context.reply("收到多少？請回覆這則訊息並輸入金額。");
      await dependencies.repository.setSetting(
        dependencies.ownerId,
        RECOVERY_PENDING_KEY,
        `${String(sent.chat.id)}:${String(sent.message_id)}:${action.ref}`,
      );
      return;
    }

    const allocationId = await resolveRef(dependencies, action.ref);
    if (!allocationId) {
      await context.answerCallbackQuery({ text: "操作已失效" });
      return;
    }
    const outstanding = await findOutstandingByAllocationId(dependencies, allocationId);
    if (!outstanding) {
      await context.answerCallbackQuery({ text: "此代墊已無餘額可放棄" });
      return;
    }
    await context.answerCallbackQuery();
    await context.editMessageText(
      `放棄回收 ${outstanding.outstanding}？此金額會計入原交易日期的個人消費。`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "確認放棄", callback_data: `aa-confirm:${action.ref}` },
              { text: "取消", callback_data: "cancel-abandon" },
            ],
          ],
        },
      },
    );
  });
}
