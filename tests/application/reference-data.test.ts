import { describe, expect, it } from "vitest";

import { listRefundCandidates } from "../../src/application/reference-data.js";
import type { ConfirmedTransaction } from "../../src/domain/ledger.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

function expense(
  id: string,
  date: string,
  merchantId: string,
  amount: string,
): ConfirmedTransaction {
  return {
    transactionId: id,
    draftId: `draft-${id}`,
    ownerId: "123",
    requestId: `request-${id}`,
    sourceEventId: `event-${id}`,
    occurredDate: date,
    merchantId,
    amount: { amount, currency: "TWD" },
    allocations: [
      {
        allocationId: `allocation-${id}`,
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount, currency: "TWD" },
        category: "購物",
      },
    ],
    confirmedAt: `${date}T00:00:00.000Z`,
    status: "confirmed",
  };
}

describe("reference application services", () => {
  it("ranks refund candidates by merchant, amount, then recent date", async () => {
    const repository = new FakeLedgerRepository();
    for (const value of [
      expense("recent", "2026-09-18", "other", "120"),
      expense("merchant", "2026-09-10", "shop", "100"),
      expense("exact", "2026-09-01", "shop", "120"),
    ])
      repository.transactions.set(value.requestId, value);

    const result = await listRefundCandidates(repository, "123", {
      merchantId: "shop",
      amount: "120",
    });
    expect(result.map((item) => item.transactionId)).toEqual(["exact", "merchant", "recent"]);
  });
});
