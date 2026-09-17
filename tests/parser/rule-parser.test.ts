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
        status: "awaiting_confirmation",
      },
    });
  });

  it("reports a missing amount instead of guessing", () => {
    expect(parseTransaction("午餐", context)).toEqual({
      kind: "missing_fields",
      fields: ["amount"],
    });
  });

  it("rejects ambiguous multiple amounts", () => {
    expect(parseTransaction("午餐 120 另加 30", context)).toEqual({
      kind: "missing_fields",
      fields: ["amount"],
    });
  });
});
