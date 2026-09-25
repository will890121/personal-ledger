import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";

import type { IncompleteDraft } from "../domain/draft.js";
import type { BatchItem } from "../application/create-batch.js";
import type { ReferenceSnapshot } from "../application/reference-data.js";
import { encodeCallback } from "./callback-data.js";

// 上限必須大於實際的第二層支出分類數（category-catalog 目前 12 個，加上由 M1 帶上來的
// legacy 分類還會更多），否則「不猜、改追問」這條路自己表達不出完整的分類表：候選依
// key 排序後截斷，排在後面的「旅遊」「待分類」會連按鈕都沒有，而分類追問只收按鈕、
// 文字回覆會被當成金額退回。仍然保留上限，是因為交易對象的數量沒有天花板。
const MAX_CANDIDATES = 24;
const BUTTONS_PER_ROW = 2;

const fieldLabels = {
  amount: "金額",
  category: "分類",
  account: "帳戶",
  refundTarget: "退款原交易",
  purpose: "用途",
  counterparty: "交易對象",
  advanceShare: "代墊金額",
} as const;

export interface DraftPrompt {
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

// 多人分帳可能有好幾筆代墊都缺交易對象，逐人追問時每一輪的候選清單與文案
// 往往完全相同——Telegram 認為訊息沒有變化會拒絕 editMessageText，使用者
// 因此看起來「按了沒反應」。從草稿的代墊配置推導「第幾位、共幾位」，讓每一輪
// 追問的文字不同，藉此避免整輪訊息與上一輪逐字相同。只有多筆代墊待指定時
// 才顯示進度，單筆分帳沒有這個問題，維持原本簡潔的文案。
function counterpartyProgress(
  partial: IncompleteDraft["partial"],
): { readonly current: number; readonly total: number } | undefined {
  const advances = partial.allocations.filter((item) => item.purpose === "advance");
  if (advances.length <= 1) return undefined;
  const filled = advances.filter((item) => item.counterpartyId).length;
  return { current: filled + 1, total: advances.length };
}

export function formatPrompt(
  draft: IncompleteDraft,
  draftRef: string,
  references: Partial<ReferenceSnapshot>,
): DraftPrompt {
  const pending = draft.pendingFields[0];
  if (!pending) throw new Error("incomplete draft must have a pending field");
  const segment = draft.partial.rawSegment;

  if (pending.field === "amount") {
    return { text: [`待補金額：${segment}`, "請回覆這則訊息並輸入金額。"].join("\n") };
  }

  if (pending.field === "advanceShare") {
    // applyAdvanceShare 的語意是「每人負擔」，文案必須把總額與人數都寫清楚，
    // 否則使用者無從判斷該填每人負擔還是代墊總額，填錯會產生金額錯誤的草稿。
    const totalAllocation = draft.partial.allocations.find((item) => item.purpose === "expense");
    const total = (totalAllocation?.amount ?? draft.partial.allocations[0]?.amount)?.amount ?? "0";
    const participantCount =
      draft.partial.allocations.filter((item) => item.purpose === "advance").length + 1;
    return {
      text: [
        `待補${fieldLabels.advanceShare}：${segment}`,
        `總額 ${total} 元，共 ${String(participantCount)} 人分攤，除不盡。`,
        "每人負擔多少？請回覆這則訊息並輸入金額。",
      ].join("\n"),
    };
  }

  if (pending.proposedName) {
    const progress = counterpartyProgress(draft.partial);
    const lines = [
      ...(progress
        ? [`待補交易對象（第 ${String(progress.current)} 位，共 ${String(progress.total)} 位）`]
        : []),
      `尚未建立「${pending.proposedName}」這個交易對象，要建立嗎？`,
    ];
    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: `建立「${pending.proposedName}」並繼續`,
              callback_data: encodeCallback({ kind: "create-counterparty", draftRef }),
            },
            { text: "取消", callback_data: `cancel:${draft.draftId}` },
          ],
        ],
      },
    };
  }

  const labels = new Map<string, string>([
    ...(references.categories ?? []).map((item) => [item.categoryId, item.name] as const),
    ...(references.accounts ?? []).map((item) => [item.accountId, item.name] as const),
    ...(references.counterparties ?? []).map((item) => [item.counterpartyId, item.name] as const),
  ]);
  const buttons: InlineKeyboardButton[] = pending.candidateIds
    .slice(0, MAX_CANDIDATES)
    .map((id, index) => ({
      text: labels.get(id) ?? id,
      callback_data: encodeCallback({ kind: "answer", draftRef, field: pending.field, index }),
    }));
  const rows = buttons.reduce<InlineKeyboardButton[][]>((acc, button, index) => {
    if (index % BUTTONS_PER_ROW === 0) acc.push([]);
    acc.at(-1)?.push(button);
    return acc;
  }, []);

  // §5.4：counterparty 的追問必須同時提供既有對象的按鈕與「回覆本訊息輸入新名稱」
  // 兩條路。尚未建立任何交易對象的帳本候選清單必定是空的，少了這句指示，使用者
  // 看到的是一則沒有任何出路的訊息。
  const progress =
    pending.field === "counterparty" ? counterpartyProgress(draft.partial) : undefined;
  const progressSuffix = progress
    ? `（第 ${String(progress.current)} 位，共 ${String(progress.total)} 位）`
    : "";
  const lines = [`待補${fieldLabels[pending.field]}${progressSuffix}：${segment}`];
  if (pending.field === "counterparty") {
    lines.push(
      buttons.length > 0
        ? "請選擇，或回覆這則訊息並輸入新的交易對象名稱。"
        : "請回覆這則訊息並輸入新的交易對象名稱。",
    );
  } else {
    lines.push("請選擇：");
  }

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

export function formatBatchSummary(items: readonly BatchItem[]): string {
  const counts = { draft: 0, incomplete: 0, unparsed: 0 };
  for (const item of items) counts[item.outcome.kind] += 1;
  const parts = [
    ...(counts.draft > 0 ? [`${String(counts.draft)} 筆待確認`] : []),
    ...(counts.incomplete > 0 ? [`${String(counts.incomplete)} 筆待補欄位`] : []),
    ...(counts.unparsed > 0 ? [`${String(counts.unparsed)} 筆無法解析`] : []),
  ];
  return `${String(items.length)} 筆：${parts.join("、")}`;
}
