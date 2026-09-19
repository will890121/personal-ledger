import type { InlineKeyboardMarkup } from "grammy/types";
import type { ConfirmedTransaction, TransactionDraft } from "../domain/ledger.js";
import type { Account, Merchant } from "../domain/reference-data.js";

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

export function formatPreview(
  draft: TransactionDraft,
  references: {
    readonly accounts?: readonly Account[];
    readonly merchants?: readonly Merchant[];
    readonly refundTarget?: ConfirmedTransaction;
  } = {},
): DraftPreview {
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
  const accountFrom = references.accounts?.find((item) => item.accountId === draft.accountFromId);
  const accountTo = references.accounts?.find((item) => item.accountId === draft.accountToId);
  const merchant = references.merchants?.find((item) => item.merchantId === draft.merchantId);
  const hasTransfer = draft.allocations.some((item) => item.purpose === "transfer");
  const referenceLines = [
    ...(merchant ? [`商家：${merchant.name}`] : []),
    ...(accountFrom ? [`${hasTransfer ? "來源帳戶" : "帳戶"}：${accountFrom.name}`] : []),
    ...(accountTo ? [`目的帳戶：${accountTo.name}`] : []),
    ...(references.refundTarget
      ? [
          `退款原交易：${references.refundTarget.occurredDate} · ${references.refundTarget.amount.currency} ${references.refundTarget.amount.amount}`,
        ]
      : []),
  ];
  return {
    text: [
      `日期：${draft.occurredDate}`,
      `總金額：${draft.amount.currency} ${draft.amount.amount}`,
      ...referenceLines,
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
