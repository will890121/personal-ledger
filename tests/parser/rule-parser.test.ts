import { describe, expect, it } from "vitest";

import { parseTransaction } from "../../src/parser/rule-parser.js";

const context = {
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "event-1",
  draftId: "draft-1",
  allocationId: "allocation-1",
  today: "2026-09-18",
};

// 照著 bootstrapReferenceData 種出來的樣子命名：第二層是「餐飲」，餐別由
// allocations.subcategory 承載。測試替身與生產各寫一份名稱，正是「午餐／午餐」
// 這種重複一路躲過測試的原因，這份 context 因此必須與 category-catalog 一致。
const bootstrappedContext = {
  ...context,
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

describe("parseTransaction", () => {
  it("parses the first deterministic lunch expense", () => {
    expect(parseTransaction("午餐 120", context)).toEqual({
      kind: "draft",
      draft: {
        draftId: "draft-1",
        ownerId: "123",
        requestId: "request-1",
        sourceEventId: "event-1",
        occurredDate: "2026-09-18",
        amount: { amount: "120", currency: "TWD" },
        allocations: [
          {
            allocationId: "allocation-1",
            fundsEffect: "outflow",
            purpose: "expense",
            amount: { amount: "120", currency: "TWD" },
            category: "餐飲",
            subcategory: "午餐",
          },
        ],
        rawInputSnapshot: "午餐 120",
        status: "awaiting_confirmation",
      },
    });
  });

  it("reports a missing amount instead of guessing", () => {
    expect(parseTransaction("午餐", context)).toEqual({
      kind: "missing_fields",
      fields: ["amount"],
      partial: {
        occurredDate: "2026-09-18",
        rawSegment: "午餐",
        allocations: [
          {
            allocationId: "allocation-1",
            fundsEffect: "outflow",
            purpose: "expense",
            category: "餐飲",
            subcategory: "午餐",
          },
        ],
      },
    });
  });

  it("rejects ambiguous multiple amounts", () => {
    const result = parseTransaction("午餐 120 另加 30", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["amount"]);
  });

  it("returns the resolved allocation shell when only the amount is missing", () => {
    const result = parseTransaction("午餐", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["amount"]);
    expect(result.partial.rawSegment).toBe("午餐");
    expect(result.partial.occurredDate).toBe("2026-09-18");
    expect(result.partial.allocations[0]).toMatchObject({
      fundsEffect: "outflow",
      purpose: "expense",
      category: "餐飲",
      subcategory: "午餐",
    });
    expect(result.partial.allocations[0]?.amount).toBeUndefined();
  });

  it("carries the relative date into the partial result", () => {
    const result = parseTransaction("昨天 午餐", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.partial.occurredDate).toBe("2026-09-17");
  });

  it("returns an allocation shell without a category when the category is unknown", () => {
    const result = parseTransaction("雜支 60", context);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["category"]);
    expect(result.partial.allocations[0]).toMatchObject({
      fundsEffect: "outflow",
      purpose: "expense",
      amount: { amount: "60", currency: "TWD" },
    });
    expect(result.partial.allocations[0]?.categoryId).toBeUndefined();
  });

  it("puts the meal in the subcategory and never repeats the category name", () => {
    const result = parseTransaction("午餐 120", bootstrappedContext);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations[0]).toEqual({
      allocationId: "allocation-1",
      fundsEffect: "outflow",
      purpose: "expense",
      amount: { amount: "120", currency: "TWD" },
      categoryId: "category-dining",
      category: "餐飲",
      subcategory: "午餐",
    });
  });

  it("maps each meal keyword to its own subcategory under 餐飲", () => {
    for (const [text, subcategory] of [
      ["早餐 100", "早餐"],
      ["晚餐 150", "晚餐"],
      ["宵夜 80", "宵夜"],
    ]) {
      const result = parseTransaction(String(text), bootstrappedContext);

      expect(result.kind).toBe("draft");
      if (result.kind !== "draft") continue;
      expect(result.draft.allocations[0]).toMatchObject({
        categoryId: "category-dining",
        category: "餐飲",
        subcategory,
      });
    }
  });

  it("does not let a mentioned account imply a category", () => {
    // M2 的行為是「沒有關鍵字但有帳戶就預設午餐」，於是「早餐 100 現金」被靜靜記成
    // 午餐、連追問都沒有。帳戶只決定 fundsEffect，不得決定分類。
    const withAccount = {
      ...bootstrappedContext,
      accounts: [
        {
          accountId: "account-cash",
          ownerId: "123",
          name: "現金",
          type: "cash" as const,
          currency: "TWD" as const,
          active: true,
        },
      ],
    };

    const result = parseTransaction("雜支 100 現金", withAccount);

    expect(result.kind).toBe("missing_fields");
    if (result.kind !== "missing_fields") return;
    expect(result.fields).toEqual(["category"]);
    expect(result.partial.allocations[0]?.categoryId).toBeUndefined();
  });

  it("names the lunch category the same way with or without seeded reference data", () => {
    const seeded = parseTransaction("午餐 120", bootstrappedContext);
    const unseeded = parseTransaction("午餐 120", context);

    expect(seeded.kind).toBe("draft");
    expect(unseeded.kind).toBe("draft");
    if (seeded.kind !== "draft" || unseeded.kind !== "draft") return;
    expect(unseeded.draft.allocations[0]?.category).toBe(seeded.draft.allocations[0]?.category);
  });
  it("lets an explicit keyword win over a registered merchant", () => {
    // 商家是店家層級的粗略訊號（Uber 同時有乘車與外送，商家表因此連 subcategory 都不給），
    // 使用者打出的「外送」是他當下明確說出的事實。反過來的話 `Uber 外送 250` 會變成
    // 交通、欄位齊全、不追問——正是這次要消滅的「自信的錯答案」。
    const withMerchant = {
      ...bootstrappedContext,
      categories: [
        ...bootstrappedContext.categories,
        {
          categoryId: "category-transport",
          ownerId: "123",
          key: "expense_transport",
          name: "交通",
          kind: "expense" as const,
          parentId: "category-expense",
          depth: 2 as const,
          active: true,
        },
      ],
      merchants: [{ merchantId: "merchant-uber", ownerId: "123", name: "Uber", active: true }],
    };

    const withKeyword = parseTransaction("Uber 外送 250", withMerchant);
    expect(withKeyword.kind).toBe("draft");
    if (withKeyword.kind !== "draft") return;
    expect(withKeyword.draft.allocations[0]).toMatchObject({
      categoryId: "category-dining",
      category: "餐飲",
      subcategory: "外送",
    });

    // 沒有關鍵字時商家才決定分類，且刻意不帶品項。
    const merchantOnly = parseTransaction("Uber 245", withMerchant);
    expect(merchantOnly.kind).toBe("draft");
    if (merchantOnly.kind !== "draft") return;
    expect(merchantOnly.draft.allocations[0]).toMatchObject({
      categoryId: "category-transport",
      category: "交通",
    });
    expect(merchantOnly.draft.allocations[0]?.subcategory).toBeUndefined();
  });
});
