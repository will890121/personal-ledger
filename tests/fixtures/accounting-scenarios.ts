import type { SummaryAllocation } from "../../src/domain/ledger-summary.js";

const allocation = (
  fundsEffect: SummaryAllocation["fundsEffect"],
  purpose: SummaryAllocation["purpose"],
  amount: string,
  categoryId: string,
  categoryKey: string,
  categoryName: string,
): SummaryAllocation => ({ fundsEffect, purpose, amount, categoryId, categoryKey, categoryName });

export const accountingScenarios = {
  effectiveAllocations: [
    allocation("inflow", "income", "85000", "income-salary", "income_salary", "薪資"),
    allocation("outflow", "expense", "120", "dining", "expense_dining", "餐飲"),
    allocation("none", "expense", "1200", "shopping", "expense_shopping", "購物"),
    allocation("internal", "transfer", "5000", "transfer", "transfer", "轉帳"),
    allocation("outflow", "transfer", "18000", "transfer", "transfer", "轉帳"),
    allocation("outflow", "fee", "15", "fee", "expense_financial_fee", "金融費用"),
    allocation("inflow", "refund", "990", "shopping", "expense_shopping", "購物"),
  ] satisfies SummaryAllocation[],
  deletedAllocation: allocation("outflow", "expense", "500", "other", "expense_other", "其他支出"),
};
