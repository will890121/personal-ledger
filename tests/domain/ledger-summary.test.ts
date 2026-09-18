import { describe, expect, it } from "vitest";

import { summarizeAllocations } from "../../src/domain/ledger-summary.js";
import { accountingScenarios } from "../fixtures/accounting-scenarios.js";

describe("summarizeAllocations", () => {
  it("calculates cash-flow and personal-finance views independently", () => {
    expect(summarizeAllocations(accountingScenarios.effectiveAllocations)).toMatchObject({
      actualInflow: { amount: "85990", currency: "TWD" },
      actualOutflow: { amount: "18135", currency: "TWD" },
      netCashFlow: { amount: "67855", currency: "TWD" },
      personalIncome: { amount: "85000", currency: "TWD" },
      grossPersonalExpense: { amount: "1335", currency: "TWD" },
      refunds: { amount: "990", currency: "TWD" },
      netPersonalExpense: { amount: "345", currency: "TWD" },
      personalBalance: { amount: "84655", currency: "TWD" },
    });
  });

  it("supports negative net expense and exact decimal arithmetic", () => {
    const result = summarizeAllocations([
      {
        fundsEffect: "none",
        purpose: "expense",
        amount: "0.1",
        categoryId: "c",
        categoryKey: "c",
        categoryName: "C",
      },
      {
        fundsEffect: "none",
        purpose: "expense",
        amount: "0.2",
        categoryId: "c",
        categoryKey: "c",
        categoryName: "C",
      },
      {
        fundsEffect: "inflow",
        purpose: "refund",
        amount: "0.4",
        categoryId: "c",
        categoryKey: "c",
        categoryName: "C",
      },
    ]);
    expect(result.grossPersonalExpense.amount).toBe("0.3");
    expect(result.netPersonalExpense.amount).toBe("-0.1");
    expect(result.categories[0]?.netExpense.amount).toBe("-0.1");
  });

  it("returns canonical zero values", () => {
    expect(summarizeAllocations([]).actualInflow.amount).toBe("0");
  });
});
