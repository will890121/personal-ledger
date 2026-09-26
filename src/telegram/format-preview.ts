import type { InlineKeyboardMarkup } from "grammy/types";
import type { ConfirmedTransaction, TransactionDraft } from "../domain/ledger.js";
import type { Account, Counterparty, Merchant } from "../domain/reference-data.js";
import { formatAllocationLines } from "./format-allocations.js";

export interface DraftPreview {
  readonly text: string;
  readonly replyMarkup: InlineKeyboardMarkup;
}

export function formatPreview(
  draft: TransactionDraft,
  references: {
    readonly accounts?: readonly Account[];
    readonly merchants?: readonly Merchant[];
    readonly counterparties?: readonly Counterparty[];
    readonly refundTarget?: ConfirmedTransaction;
  } = {},
): DraftPreview {
  if (draft.allocations.length === 0) throw new Error("draft must contain an allocation");
  const allocationLines = formatAllocationLines(draft.allocations, references.counterparties);
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
      "",
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
