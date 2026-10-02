import type { LedgerSummary } from "./ledger-summary.js";
import type { SheetCell } from "./sheet-rows.js";

export interface DatedTransaction {
  readonly transactionId: string;
  readonly occurredDate: string;
}

const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/**
 * 哪些月份的摘要需要重算。
 *
 * `previousDatesById` 是 Sheet 上這些 transaction_id 現有的日期。它存在的唯一理由是
 * 跨月搬移：一筆交易從 9 月改到 10 月時，兩個月的摘要都變了，但只看新資料只知道
 * 10 月，9 月會靜默停在錯的數字。Sheet 上的舊值是唯一能知道舊月份的來源，
 * 而同步本來就要讀 Transactions 分頁的鍵欄，順便讀日期欄不增加任何呼叫。
 */
export function affectedMonths(
  changed: readonly DatedTransaction[],
  previousDatesById: ReadonlyMap<string, string>,
): string[] {
  const months = new Set<string>();
  for (const txn of changed) {
    months.add(monthOf(txn.occurredDate));
    const previous = previousDatesById.get(txn.transactionId);
    if (previous !== undefined) months.add(monthOf(previous));
  }
  return [...months].sort();
}

/** `YYYY-MM` → 該月第一天與最後一天，供 SummaryRepository.summarize 使用。 */
export function monthRange(month: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`not a YYYY-MM month: ${month}`);
  const [, year, monthNumber] = match;
  // 下個月的第 0 天就是這個月的最後一天，閏年與大小月都不必自己算。
  const lastDay = new Date(Date.UTC(Number(year), Number(monthNumber), 0)).getUTCDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

export function monthlySummaryRow(month: string, summary: LedgerSummary, now: Date): SheetCell[] {
  const money = (value: string): SheetCell => ({ kind: "number", value: Number(value) });
  return [
    { kind: "string", value: month },
    money(summary.actualInflow.amount),
    money(summary.actualOutflow.amount),
    money(summary.netCashFlow.amount),
    money(summary.personalIncome.amount),
    money(summary.grossPersonalExpense.amount),
    money(summary.refunds.amount),
    money(summary.netPersonalExpense.amount),
    money(summary.personalBalance.amount),
    { kind: "string", value: now.toISOString() },
  ];
}
