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

// 生產環境經 bootstrapReferenceData 種進去的午餐葉分類，名稱本身就叫「午餐」；
// 測試替身以前一律取名「餐飲」，於是「分類名稱與 subcategory 重複」在測試裡永遠
// 看不見，只有真實資料庫會渲染成「午餐／午餐」。這份 context 照著生產資料命名。
const bootstrappedContext = {
  ...context,
  categories: [
    {
      categoryId: "category-lunch",
      ownerId: "123",
      key: "expense_dining_lunch",
      name: "午餐",
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
            category: "午餐",
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
            category: "午餐",
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
      category: "午餐",
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
    const result = parseTransaction("咖啡 60", context);

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

  it("does not repeat the resolved lunch category name as a subcategory", () => {
    const result = parseTransaction("午餐 120", bootstrappedContext);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations[0]).toEqual({
      allocationId: "allocation-1",
      fundsEffect: "outflow",
      purpose: "expense",
      amount: { amount: "120", currency: "TWD" },
      categoryId: "category-lunch",
      category: "午餐",
    });
  });

  it("names the lunch category the same way with or without seeded reference data", () => {
    const seeded = parseTransaction("午餐 120", bootstrappedContext);
    const unseeded = parseTransaction("午餐 120", context);

    expect(seeded.kind).toBe("draft");
    expect(unseeded.kind).toBe("draft");
    if (seeded.kind !== "draft" || unseeded.kind !== "draft") return;
    expect(unseeded.draft.allocations[0]?.category).toBe(seeded.draft.allocations[0]?.category);
  });
});
