import { describe, expect, it } from "vitest";

import {
  computeOutstanding,
  planRecovery,
  splitForAbandonment,
  type AdvanceRow,
} from "../../src/domain/advance.js";

const rows: AdvanceRow[] = [
  {
    allocationId: "A1",
    transactionId: "T1",
    occurredDate: "2026-03-01",
    counterpartyId: "jia",
    category: "餐飲",
    amount: "100",
  },
  {
    allocationId: "A2",
    transactionId: "T2",
    occurredDate: "2026-03-05",
    counterpartyId: "jia",
    category: "餐飲",
    amount: "200",
  },
];

describe("computeOutstanding", () => {
  it("subtracts recoveries from each advance", () => {
    const result = computeOutstanding(rows, [{ recoversAllocationId: "A1", amount: "40" }]);

    expect(result.map((item) => [item.allocationId, item.outstanding])).toEqual([
      ["A1", "60"],
      ["A2", "200"],
    ]);
  });

  it("drops fully recovered advances", () => {
    const result = computeOutstanding(rows, [{ recoversAllocationId: "A1", amount: "100" }]);

    expect(result.map((item) => item.allocationId)).toEqual(["A2"]);
  });

  it("sorts oldest first", () => {
    const reversedRows = [rows[1], rows[0]].filter((row): row is AdvanceRow => row !== undefined);
    const result = computeOutstanding(reversedRows, []);

    expect(result.map((item) => item.allocationId)).toEqual(["A1", "A2"]);
  });
});

describe("planRecovery", () => {
  it("allocates one payment across several advances oldest first", () => {
    const outstanding = computeOutstanding(rows, []);

    const plan = planRecovery(outstanding, "300");

    expect(plan.items.map((item) => [item.advance.allocationId, item.amount])).toEqual([
      ["A1", "100"],
      ["A2", "200"],
    ]);
    expect(plan.surplus).toBe("0");
  });

  it("stops when the payment runs out", () => {
    const outstanding = computeOutstanding(rows, []);

    const plan = planRecovery(outstanding, "150");

    expect(plan.items.map((item) => [item.advance.allocationId, item.amount])).toEqual([
      ["A1", "100"],
      ["A2", "50"],
    ]);
    expect(plan.surplus).toBe("0");
  });

  it("reports the surplus when the payment exceeds every advance", () => {
    const row = rows[1];
    if (!row) throw new Error("row not found");
    const outstanding = computeOutstanding([row], []);

    const plan = planRecovery(outstanding, "700");

    expect(plan.items.map((item) => item.amount)).toEqual(["200"]);
    expect(plan.surplus).toBe("500");
  });
});

describe("splitForAbandonment", () => {
  const allocations = [
    {
      allocationId: "mine",
      fundsEffect: "outflow" as const,
      purpose: "expense" as const,
      amount: { amount: "630", currency: "TWD" as const },
      category: "餐飲",
    },
    {
      allocationId: "theirs",
      fundsEffect: "outflow" as const,
      purpose: "advance" as const,
      amount: { amount: "630", currency: "TWD" as const },
      category: "餐飲",
      counterpartyId: "friend",
    },
  ];

  it("splits a partially recovered advance into advance and expense", () => {
    const result = splitForAbandonment(allocations, "theirs", "300", "abandoned");

    expect(result).toHaveLength(3);
    expect(result.find((item) => item.allocationId === "theirs")?.amount.amount).toBe("300");
    const abandoned = result.find((item) => item.allocationId === "abandoned");
    expect(abandoned).toMatchObject({
      purpose: "expense",
      fundsEffect: "outflow",
      category: "餐飲",
      counterpartyId: "friend",
    });
    expect(abandoned?.amount.amount).toBe("330");
  });

  it("converts the whole allocation when nothing was recovered", () => {
    const result = splitForAbandonment(allocations, "theirs", "0", "abandoned");

    expect(result).toHaveLength(2);
    expect(result.find((item) => item.allocationId === "theirs")).toMatchObject({
      purpose: "expense",
      amount: { amount: "630" },
    });
    expect(result.some((item) => item.allocationId === "abandoned")).toBe(false);
  });

  it("refuses to abandon an allocation that is fully recovered", () => {
    expect(() => splitForAbandonment(allocations, "theirs", "630", "abandoned")).toThrow();
  });
});
