import { describe, expect, it } from "vitest";

import { summarizeAllocations } from "../../src/domain/ledger-summary.js";

describe("advance statistics", () => {
  it("counts an advance as an outflow but not as personal expense", () => {
    const summary = summarizeAllocations([
      {
        fundsEffect: "outflow",
        purpose: "expense",
        amount: "630",
        categoryId: "c1",
        categoryKey: "expense_dining",
        categoryName: "餐飲",
      },
      {
        fundsEffect: "outflow",
        purpose: "advance",
        amount: "630",
        categoryId: "c1",
        categoryKey: "expense_dining",
        categoryName: "餐飲",
      },
    ]);

    expect(summary.actualOutflow.amount).toBe("1260");
    expect(summary.grossPersonalExpense.amount).toBe("630");
    expect(summary.categories[0]?.netExpense.amount).toBe("630");
  });

  it("counts a recovery as an inflow but not as personal income", () => {
    const summary = summarizeAllocations([
      {
        fundsEffect: "inflow",
        purpose: "advance_recovery",
        amount: "300",
        categoryId: "c1",
        categoryKey: "expense_dining",
        categoryName: "餐飲",
      },
    ]);

    expect(summary.actualInflow.amount).toBe("300");
    expect(summary.personalIncome.amount).toBe("0");
    expect(summary.categories).toEqual([]);
  });
});
