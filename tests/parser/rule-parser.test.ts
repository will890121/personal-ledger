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
});
