import type { MirrorTransaction } from "../ports/sheet-sync-repository.js";

import { toSheetSerialDate } from "./sheet-serial-date.js";

/**
 * 一個儲存格的值與它的型別。型別由我們明確決定，不交給 Sheets 去猜——
 * 交給它猜就等於開放公式注入（見 spec §4）。
 */
export type SheetCell =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "date"; readonly value: number }
  | { readonly kind: "empty" };

const text = (value: string | null): SheetCell =>
  value === null || value === "" ? { kind: "empty" } : { kind: "string", value };

// 金額故意用 Number(value)：這是 spec §4 明載的、經過裁決的例外。Sheet 是給人分析的
// 投影，寫成文字就不能 SUM——那會讓這個功能失去存在意義。SQLite 仍是唯一真相，
// Decimal 仍管所有運算；這裡只是把已經算好的金額字串轉成 Sheets 認得的 number。
const money = (value: string): SheetCell => ({ kind: "number", value: Number(value) });

const date = (value: string): SheetCell => ({ kind: "date", value: toSheetSerialDate(value) });

export const TRANSACTIONS_HEADER = [
  "transaction_id",
  "日期",
  "時間",
  "金額",
  "轉出帳戶",
  "轉入帳戶",
  "商家",
  "對象",
  "備註",
  "原始輸入",
  "狀態",
  "確認時間",
  "更新時間",
] as const;

export const ALLOCATIONS_HEADER = [
  "allocation_id",
  "transaction_id",
  "日期",
  "資金流向",
  "用途",
  "金額",
  "分類",
  "子分類",
  "對象",
  "備註",
  "交易狀態",
] as const;

export const MONTHLY_SUMMARY_HEADER = [
  "月份",
  "實際流入",
  "實際流出",
  "淨現金流",
  "個人收入",
  "個人支出毛額",
  "退款",
  "個人支出淨額",
  "個人結餘",
  "更新時間",
] as const;

export function transactionRow(txn: MirrorTransaction): SheetCell[] {
  return [
    text(txn.transactionId),
    date(txn.occurredDate),
    text(txn.occurredTime),
    money(txn.amount),
    text(txn.accountFromName),
    text(txn.accountToName),
    text(txn.merchantName),
    text(txn.counterpartyName),
    text(txn.note),
    text(txn.rawInputSnapshot),
    text(txn.status),
    text(txn.confirmedAt),
    text(txn.updatedAt),
  ];
}

export function allocationRows(txn: MirrorTransaction): SheetCell[][] {
  return txn.allocations.map((allocation) => [
    text(allocation.allocationId),
    text(txn.transactionId),
    date(txn.occurredDate),
    text(allocation.fundsEffect),
    text(allocation.purpose),
    money(allocation.amount),
    text(allocation.categoryName),
    text(allocation.subcategoryName),
    text(allocation.counterpartyName),
    text(allocation.note),
    text(txn.status),
  ]);
}
