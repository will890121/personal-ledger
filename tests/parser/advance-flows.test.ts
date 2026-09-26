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
      key: "expense_dining",
      name: "餐飲",
      kind: "expense" as const,
      parentId: "category-expense",
      depth: 2 as const,
      active: true,
    },
  ],
};

const contextWithXiaoming = {
  ...context,
  counterparties: [
    ...context.counterparties,
    { counterpartyId: "xiaoming", ownerId: "123", name: "小明", active: true },
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
    // 無具名時 counterparty 也還缺著，必須跟 advanceShare 一起宣告（見本輪修正）。
    expect(result.fields).toEqual(["advanceShare", "counterparty"]);
  });

  it("produces one placeholder per other participant when three people split unevenly", () => {
    const result = parseTransaction("午餐 1000，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare", "counterparty"]);
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
    expect(result.fields).toEqual(["advanceShare", "counterparty"]);
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

  it("asks for both the share and the counterparty when names are missing", () => {
    const result = parseTransaction("午餐 1000，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare", "counterparty"]);
    expect(result.partial.allocations).toHaveLength(3);
    expect(result.partial.allocations[1]?.amount).toBeUndefined();
    expect(result.partial.allocations[2]?.amount).toBeUndefined();
  });

  it("asks only for the share when every name resolves", () => {
    const result = parseTransaction("午餐 1001，小明欠一半", contextWithXiaoming);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["advanceShare"]);
  });
});

// 「午餐」是解析器唯一硬編碼分類的詞。分帳測試全用它，等於從沒驗過「分類未知」
// 這條路——AC-11 的官方語句「聚餐」正是走這條，而它原本會落到「無法解析」。
describe("advance parsing when the category is unknown", () => {
  it("keeps the split shell and asks for the category (AC-11)", () => {
    const result = parseTransaction("聚餐 1260，我先付，朋友欠一半", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["category"]);
    // 配置不得為空：空配置會被 create-batch 降級成「無法解析」，連草稿都不建。
    expect(result.partial.allocations).toHaveLength(2);
    expect(result.partial.allocations.map((item) => item.amount?.amount)).toEqual(["630", "630"]);
    expect(result.partial.allocations.map((item) => item.purpose)).toEqual(["expense", "advance"]);
    expect(result.partial.allocations[0]).toMatchObject({
      fundsEffect: "outflow",
      category: "待分類",
    });
    expect(result.partial.allocations[0]?.categoryId).toBeUndefined();
    expect(result.partial.allocations[1]?.counterpartyId).toBe("friend");
  });

  it("asks for the category and the counterparty when an explicit share names a stranger", () => {
    const result = parseTransaction("聚餐 1260，小明欠 630", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["category", "counterparty"]);
    expect(result.partial.allocations.map((item) => item.amount?.amount)).toEqual(["630", "630"]);
  });

  it("asks for the category alongside the share when the split does not divide", () => {
    const result = parseTransaction("聚餐 1000，三個人平分", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["category", "advanceShare", "counterparty"]);
    expect(result.partial.allocations).toHaveLength(3);
    expect(result.partial.allocations[1]?.amount).toBeUndefined();
  });

  it("splits an unknown category for a known counterparty once the split is exact", () => {
    const result = parseTransaction("聚餐 600，朋友欠 600", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["category"]);
    // 整筆都是代墊：不產生 0 元的個人配置。
    expect(result.partial.allocations).toHaveLength(1);
    expect(result.partial.allocations[0]).toMatchObject({ purpose: "advance" });
  });
});

// explicit 前置攔截（Ruling 10）排在金額關卡之前，也因此排到了「退款」與「卡」
// 兩道關卡之前。同一語意的兩種寫法必須通過同一組關卡，否則刷卡代墊會被誤記成
// 實際流出（設計 §4.2 要求 none:advance），污染 /today、/month 的實際流出。
describe("advance parsing goes through the same guards on both paths", () => {
  it("asks for the account for a card split written either way", () => {
    const explicit = parseTransaction("午餐 1260 刷卡，朋友欠 630", context);
    const half = parseTransaction("午餐 1260 刷卡，朋友欠一半", context);

    expect(explicit.kind).toBe("missing_fields");
    if (explicit.kind !== "missing_fields") return;
    expect(half.kind).toBe("missing_fields");
    if (half.kind !== "missing_fields") return;
    expect(explicit.fields).toEqual(["account"]);
    expect(explicit.fields).toEqual(half.fields);
  });

  it("routes a refund with an explicit share to the refund follow-up", () => {
    const result = parseTransaction("退款 1260，朋友欠 630", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["refundTarget", "category"]);
  });
});
