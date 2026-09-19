import type { LedgerSummary } from "../domain/ledger-summary.js";

export function formatSummary(title: string, summary: LedgerSummary): string {
  const money = (amount: string) => `TWD ${amount}`;
  const categories = summary.categories.length
    ? summary.categories.map(
        (item, index) =>
          `${String(index + 1)}. ${item.categoryName}：${money(item.netExpense.amount)}`,
      )
    : ["尚無分類支出。"];
  return [
    title,
    `實際流入：${money(summary.actualInflow.amount)}`,
    `實際流出：${money(summary.actualOutflow.amount)}`,
    `淨資金流：${money(summary.netCashFlow.amount)}`,
    `個人收入：${money(summary.personalIncome.amount)}`,
    `個人總支出：${money(summary.grossPersonalExpense.amount)}`,
    `退款：${money(summary.refunds.amount)}`,
    `個人淨支出：${money(summary.netPersonalExpense.amount)}`,
    `個人收支結餘：${money(summary.personalBalance.amount)}`,
    "分類淨支出：",
    ...categories,
  ].join("\n");
}
