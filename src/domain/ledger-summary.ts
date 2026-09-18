import { Decimal } from "decimal.js";
import { z } from "zod";

import { FundsEffectSchema, PurposeSchema } from "./ledger.js";

const SummaryAmountSchema = z.string().transform((value, context) => {
  try {
    const amount = new Decimal(value);
    if (amount.isFinite()) return amount.toString();
  } catch {
    // Report a domain validation issue below.
  }
  context.addIssue({ code: "custom", message: "summary amount must be finite" });
  return z.NEVER;
});

export const SummaryMoneySchema = z.object({
  amount: SummaryAmountSchema,
  currency: z.literal("TWD"),
});

export const SummaryAllocationSchema = z.object({
  fundsEffect: FundsEffectSchema,
  purpose: PurposeSchema,
  amount: z.string(),
  categoryId: z.string().min(1),
  categoryKey: z.string().min(1),
  categoryName: z.string().min(1),
});
export type SummaryAllocation = z.infer<typeof SummaryAllocationSchema>;

export const CategorySummarySchema = z.object({
  categoryId: z.string().min(1),
  categoryKey: z.string().min(1),
  categoryName: z.string().min(1),
  netExpense: SummaryMoneySchema,
});

export const LedgerSummarySchema = z.object({
  actualInflow: SummaryMoneySchema,
  actualOutflow: SummaryMoneySchema,
  netCashFlow: SummaryMoneySchema,
  personalIncome: SummaryMoneySchema,
  grossPersonalExpense: SummaryMoneySchema,
  refunds: SummaryMoneySchema,
  netPersonalExpense: SummaryMoneySchema,
  personalBalance: SummaryMoneySchema,
  categories: z.array(CategorySummarySchema),
});
export type LedgerSummary = z.infer<typeof LedgerSummarySchema>;

const twd = (amount: Decimal) => ({ amount: amount.toString(), currency: "TWD" as const });

export function summarizeAllocations(input: readonly SummaryAllocation[]): LedgerSummary {
  let actualInflow = new Decimal(0);
  let actualOutflow = new Decimal(0);
  let personalIncome = new Decimal(0);
  let grossPersonalExpense = new Decimal(0);
  let refunds = new Decimal(0);
  const categories = new Map<string, { key: string; name: string; amount: Decimal }>();

  for (const raw of input) {
    const allocation = SummaryAllocationSchema.parse(raw);
    const amount = new Decimal(allocation.amount);
    if (allocation.fundsEffect === "inflow") actualInflow = actualInflow.plus(amount);
    if (allocation.fundsEffect === "outflow") actualOutflow = actualOutflow.plus(amount);
    if (allocation.purpose === "income") personalIncome = personalIncome.plus(amount);
    if (allocation.purpose === "expense" || allocation.purpose === "fee") {
      grossPersonalExpense = grossPersonalExpense.plus(amount);
    }
    if (allocation.purpose === "refund") refunds = refunds.plus(amount);
    if (["expense", "fee", "refund"].includes(allocation.purpose)) {
      const current = categories.get(allocation.categoryId) ?? {
        key: allocation.categoryKey,
        name: allocation.categoryName,
        amount: new Decimal(0),
      };
      current.amount =
        allocation.purpose === "refund"
          ? current.amount.minus(amount)
          : current.amount.plus(amount);
      categories.set(allocation.categoryId, current);
    }
  }

  const netPersonalExpense = grossPersonalExpense.minus(refunds);
  return LedgerSummarySchema.parse({
    actualInflow: twd(actualInflow),
    actualOutflow: twd(actualOutflow),
    netCashFlow: twd(actualInflow.minus(actualOutflow)),
    personalIncome: twd(personalIncome),
    grossPersonalExpense: twd(grossPersonalExpense),
    refunds: twd(refunds),
    netPersonalExpense: twd(netPersonalExpense),
    personalBalance: twd(personalIncome.minus(netPersonalExpense)),
    categories: [...categories.entries()]
      .map(([categoryId, value]) => ({
        categoryId,
        categoryKey: value.key,
        categoryName: value.name,
        netExpense: twd(value.amount),
      }))
      .sort((left, right) => {
        const amountOrder = new Decimal(right.netExpense.amount).comparedTo(left.netExpense.amount);
        return amountOrder || left.categoryKey.localeCompare(right.categoryKey);
      }),
  });
}
