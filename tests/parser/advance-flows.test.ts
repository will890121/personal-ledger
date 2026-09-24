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

  it("produces one placeholder per other participant when three people split unevenly", () => {
    const result = parseTransaction("午餐 1000，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare"]);
    // 1 筆個人支出 + 2 筆代墊 placeholder（三人平分，扣掉自己還有兩人）。
    expect(result.partial.allocations).toHaveLength(3);
    expect(result.partial.allocations[0]?.purpose).toBe("expense");
    expect(result.partial.allocations[1]?.purpose).toBe("advance");
    expect(result.partial.allocations[2]?.purpose).toBe("advance");
  });

  it("produces one placeholder per other participant when four people split unevenly", () => {
    const result = parseTransaction("午餐 999，四個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare"]);
    // 1 筆個人支出 + 3 筆代墊 placeholder（四人平分，扣掉自己還有三人）。
    expect(result.partial.allocations).toHaveLength(4);
    expect(result.partial.allocations[0]?.purpose).toBe("expense");
    expect(result.partial.allocations[1]?.purpose).toBe("advance");
    expect(result.partial.allocations[2]?.purpose).toBe("advance");
    expect(result.partial.allocations[3]?.purpose).toBe("advance");
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

  it("splits an explicit equal amount for a known counterparty", () => {
    const result = parseTransaction("午餐 1260，朋友欠 630", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("1260");
    expect(result.draft.allocations).toHaveLength(2);
    expect(result.draft.allocations[0]).toMatchObject({ purpose: "expense" });
    expect(result.draft.allocations[0]?.amount.amount).toBe("630");
    expect(result.draft.allocations[1]).toMatchObject({
      purpose: "advance",
      counterpartyId: "friend",
    });
    expect(result.draft.allocations[1]?.amount.amount).toBe("630");
  });

  it("splits an explicit unequal amount for a known counterparty", () => {
    const result = parseTransaction("午餐 1000，朋友欠 400", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("1000");
    expect(result.draft.allocations).toHaveLength(2);
    expect(result.draft.allocations[0]).toMatchObject({ purpose: "expense" });
    expect(result.draft.allocations[0]?.amount.amount).toBe("600");
    expect(result.draft.allocations[1]).toMatchObject({
      purpose: "advance",
      counterpartyId: "friend",
    });
    expect(result.draft.allocations[1]?.amount.amount).toBe("400");
  });

  it("does not produce a zero-amount personal allocation when the whole amount is advanced", () => {
    const result = parseTransaction("午餐 600，朋友欠 600", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("600");
    expect(result.draft.allocations).toHaveLength(1);
    expect(result.draft.allocations[0]).toMatchObject({
      purpose: "advance",
      counterpartyId: "friend",
    });
    expect(result.draft.allocations[0]?.amount.amount).toBe("600");
  });

  it("asks for the advance amount when the explicit share exceeds the total", () => {
    const result = parseTransaction("午餐 500，朋友欠 800", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare"]);
  });

  it("asks for the counterparty when the explicit named payer is unknown", () => {
    const result = parseTransaction("午餐 1260，小明欠 630", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["counterparty"]);
  });

  it("leaves a sentence with an unrelated second amount to the amount follow-up", () => {
    const result = parseTransaction("午餐 120 另加 30", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["amount"]);
  });

  it("treats a single amount owed entirely by a counterparty as a full advance", () => {
    const result = parseTransaction("午餐 朋友欠1260", context);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("1260");
    expect(result.draft.allocations).toHaveLength(1);
    expect(result.draft.allocations[0]).toMatchObject({
      purpose: "advance",
      counterpartyId: "friend",
    });
    expect(result.draft.allocations[0]?.amount.amount).toBe("1260");
  });

  it("builds advance placeholders for an unnamed even split so the intent is not lost", () => {
    const result = parseTransaction("午餐 999，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["counterparty"]);
    expect(result.partial.allocations).toHaveLength(3);
    expect(result.partial.allocations.map((item) => item.amount?.amount)).toEqual([
      "333",
      "333",
      "333",
    ]);
  });

  it("leaves advance placeholder amounts undefined when the split does not divide", () => {
    const result = parseTransaction("午餐 1000，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare"]);
    expect(result.partial.allocations).toHaveLength(3);
    expect(result.partial.allocations[1]?.amount).toBeUndefined();
    expect(result.partial.allocations[2]?.amount).toBeUndefined();
  });
});
