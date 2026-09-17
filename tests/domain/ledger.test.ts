import { describe, expect, it } from "vitest";

import { TransactionDraftSchema } from "../../src/domain/ledger.js";

describe("TransactionDraftSchema", () => {
  it("rejects a draft whose allocations do not equal its total", () => {
    const result = TransactionDraftSchema.safeParse({
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
          amount: { amount: "100", currency: "TWD" },
          category: "餐飲",
          subcategory: "午餐",
        },
      ],
      status: "awaiting_confirmation",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "allocation total must equal transaction amount" }),
        ]),
      );
    }
  });
});
