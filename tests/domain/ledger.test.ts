import { describe, expect, it } from "vitest";

import { TransactionDraftSchema } from "../../src/domain/ledger.js";

function makeDraft(overrides: {
  fundsEffect: string;
  purpose: string;
  accountFromId?: string;
  accountToId?: string;
}) {
  return {
    draftId: "draft-1",
    ownerId: "123",
    requestId: "request-1",
    sourceEventId: "event-1",
    occurredDate: "2026-09-18",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: "allocation-1",
        fundsEffect: overrides.fundsEffect,
        purpose: overrides.purpose,
        amount: { amount: "120", currency: "TWD" },
        categoryId: "category-1",
        category: "餐飲",
      },
    ],
    status: "awaiting_confirmation",
    ...(overrides.accountFromId ? { accountFromId: overrides.accountFromId } : {}),
    ...(overrides.accountToId ? { accountToId: overrides.accountToId } : {}),
  };
}

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

  it.each([
    ["inflow", "income"],
    ["outflow", "expense"],
    ["none", "expense"],
    ["internal", "transfer"],
    ["outflow", "transfer"],
    ["inflow", "refund"],
    ["none", "refund"],
    ["outflow", "fee"],
  ] as const)("accepts %s + %s", (fundsEffect, purpose) => {
    const accounts =
      fundsEffect === "internal" ? { accountFromId: "account-1", accountToId: "account-2" } : {};

    expect(() =>
      TransactionDraftSchema.parse(makeDraft({ fundsEffect, purpose, ...accounts })),
    ).not.toThrow();
  });

  it.each([
    ["inflow", "expense"],
    ["internal", "income"],
    ["none", "fee"],
  ] as const)("rejects %s + %s", (fundsEffect, purpose) => {
    expect(() => TransactionDraftSchema.parse(makeDraft({ fundsEffect, purpose }))).toThrow(
      "unsupported accounting shape",
    );
  });

  it("requires distinct source and destination accounts for an internal transfer", () => {
    expect(() =>
      TransactionDraftSchema.parse(makeDraft({ fundsEffect: "internal", purpose: "transfer" })),
    ).toThrow("internal transfer requires distinct accounts");

    expect(() =>
      TransactionDraftSchema.parse(
        makeDraft({
          fundsEffect: "internal",
          purpose: "transfer",
          accountFromId: "account-1",
          accountToId: "account-1",
        }),
      ),
    ).toThrow("internal transfer requires distinct accounts");
  });

  it("rejects a no-funds-effect expense with a destination account", () => {
    expect(() =>
      TransactionDraftSchema.parse(
        makeDraft({
          fundsEffect: "none",
          purpose: "expense",
          accountFromId: "card-1",
          accountToId: "account-2",
        }),
      ),
    ).toThrow("credit expense cannot have a destination account");
  });
});
