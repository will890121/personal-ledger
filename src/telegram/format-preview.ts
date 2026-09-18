import type { InlineKeyboardMarkup } from "grammy/types";
import type { TransactionDraft } from "../domain/ledger.js";

const effectLabels: Record<TransactionDraft["allocations"][number]["fundsEffect"], string> = {
  inflow: "資金流入",
  outflow: "資金流出",
  internal: "內部移轉",
  none: "不影響當下可動用資金",
};
const purposeLabels: Record<TransactionDraft["allocations"][number]["purpose"], string> = {
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

export interface DraftPreview {
  readonly text: string;
  readonly replyMarkup: InlineKeyboardMarkup;
}

export function formatPreview(draft: TransactionDraft): DraftPreview {
  if (draft.allocations.length === 0) throw new Error("draft must contain an allocation");
  const allocationLines = draft.allocations.flatMap((allocation, index) => {
    const category = allocation.subcategory
      ? `${allocation.category}／${allocation.subcategory}`
      : allocation.category;
    return [
      `配置 ${String(index + 1)}：${purposeLabels[allocation.purpose]} · ${effectLabels[allocation.fundsEffect]}`,
      `分類：${category} · ${allocation.amount.currency} ${allocation.amount.amount}`,
    ];
  });
  return {
    text: [
      `日期：${draft.occurredDate}`,
      `總金額：${draft.amount.currency} ${draft.amount.amount}`,
      ...allocationLines,
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
