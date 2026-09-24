import { describe, expect, it } from "vitest";

import { parseTransaction } from "../../src/parser/rule-parser.js";

const context = {
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "event-1",
  draftId: "draft-1",
  allocationId: "allocation-1",
  advanceAllocationIds: ["advance-1", "advance-2"],
  today: "2026-09-24",
  counterparties: [{ counterpartyId: "friend", ownerId: "123", name: "朋友", active: true }],
  categories: [
    {
      categoryId: "category-dining",
      ownerId: "123",
      key: "expense_dining_lunch",
      name: "餐飲",
      kind: "expense" as const,
      parentId: "category-expense",
      depth: 2 as const,
      active: true,
    },
  ],
};

describe("advance parsing", () => {
  it("splits a known counterparty's half into an advance allocation", () => {
    const result = parseTransaction("午餐 1260，朋友欠一半", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("1260");
    expect(result.draft.allocations).toHaveLength(2);
    expect(result.draft.allocations[0]).toMatchObject({ purpose: "expense" });
    expect(result.draft.allocations[0]?.amount.amount).toBe("630");
    expect(result.draft.allocations[1]).toMatchObject({
      purpose: "advance",
      fundsEffect: "outflow",
      counterpartyId: "friend",
    });
    expect(result.draft.allocations[1]?.amount.amount).toBe("630");
  });

  it("asks for the counterparty when the name is unknown", () => {
    const result = parseTransaction("午餐 1260，小明欠一半", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["counterparty"]);
    expect(result.partial.allocations).toHaveLength(2);
    expect(result.partial.allocations[1]?.purpose).toBe("advance");
  });

  it("asks for the advance amount when the split does not divide exactly", () => {
    const result = parseTransaction("午餐 1000，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare"]);
  });

  it("marks a credit card advance as not affecting available funds", () => {
    const result = parseTransaction("午餐 1260 國泰卡，朋友欠一半", {
      ...context,
      accounts: [
        {
          accountId: "cathay-card",
          ownerId: "123",
          name: "國泰卡",
          type: "credit_card" as const,
          currency: "TWD" as const,
          active: true,
        },
      ],
    });

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations.map((item) => item.fundsEffect)).toEqual(["none", "none"]);
  });

  it("leaves sentences without a sharing phrase unchanged", () => {
    const result = parseTransaction("午餐 120", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations).toHaveLength(1);
  });
});
