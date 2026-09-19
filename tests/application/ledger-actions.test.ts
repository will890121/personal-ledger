import { describe, expect, it } from "vitest";

import { cancelDraft, confirmDraft } from "../../src/application/confirm-draft.js";
import { listRecent } from "../../src/application/list-recent.js";
import type { TransactionDraft } from "../../src/domain/ledger.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

function makeDraft(index: number): TransactionDraft {
  const suffix = String(index);
  return {
    draftId: `draft-${suffix}`,
    ownerId: "123",
    requestId: `request-${suffix}`,
    sourceEventId: `event-${suffix}`,
    occurredDate: "2026-09-18",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: `allocation-${suffix}`,
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount: "120", currency: "TWD" },
        category: "餐飲",
        subcategory: "午餐",
      },
    ],
    status: "awaiting_confirmation",
  };
}

describe("ledger actions", () => {
  it("returns the same transaction when a draft is confirmed twice", async () => {
    const repository = new FakeLedgerRepository();
    await repository.saveDraft(makeDraft(1));

    const first = await confirmDraft(repository, "draft-1", "2026-09-18T01:00:00.000Z", "audit-1");
    const second = await confirmDraft(repository, "draft-1", "2026-09-18T01:01:00.000Z", "audit-2");

    expect(second).toEqual(first);
    expect(repository.transactions.size).toBe(1);
  });

  it("cancels a draft without creating a transaction", async () => {
    const repository = new FakeLedgerRepository();
    await repository.saveDraft(makeDraft(1));

    await expect(cancelDraft(repository, "draft-1")).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(repository.transactions.size).toBe(0);
  });

  it("limits recent transactions to fifty in newest-first order", async () => {
    const repository = new FakeLedgerRepository();
    for (let index = 1; index <= 55; index += 1) {
      await repository.saveDraft(makeDraft(index));
      await repository.confirmDraft(
        `draft-${String(index)}`,
        `2026-09-18T01:${String(index).padStart(2, "0")}:00.000Z`,
        `audit-${String(index)}`,
      );
    }

    const recent = await listRecent(repository, "123", 100);

    expect(recent).toHaveLength(50);
    expect(recent[0]?.draftId).toBe("draft-55");
    expect(recent[49]?.draftId).toBe("draft-6");
  });
});
