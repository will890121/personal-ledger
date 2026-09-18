import type { InlineKeyboardMarkup } from "grammy/types";

import type { TransactionDraft } from "../domain/ledger.js";

const effectLabels: Record<TransactionDraft["allocations"][number]["fundsEffect"], string> = {
  inflow: "流入",
  outflow: "支出",
  internal: "內部移轉",
  none: "不影響可用資金",
};

export interface DraftPreview {
  readonly text: string;
  readonly replyMarkup: InlineKeyboardMarkup;
}

export function formatPreview(draft: TransactionDraft): DraftPreview {
  const allocation = draft.allocations[0];
  if (!allocation) {
    throw new Error("draft must contain an allocation");
  }
  const category = allocation.subcategory
    ? `${allocation.category}／${allocation.subcategory}`
    : allocation.category;

  return {
    text: [
      `日期：${draft.occurredDate}`,
      `類型：${effectLabels[allocation.fundsEffect]}`,
      `金額：${draft.amount.currency} ${draft.amount.amount}`,
      `分類：${category}`,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "確認", callback_data: `confirm:${draft.draftId}` },
          { text: "取消", callback_data: `cancel:${draft.draftId}` },
        ],
      ],
    },
  };
}
