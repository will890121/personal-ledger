import { describe, expect, it } from "vitest";

import {
  recordRecovery,
  type RecordRecoveryDependencies,
} from "../../src/application/record-recovery.js";
import { ConfirmedTransactionSchema, type ConfirmedTransaction } from "../../src/domain/ledger.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

const baseCommand = {
  ownerId: "owner-1",
  counterpartyId: "counterparty-1",
  occurredDate: "2026-09-24",
  telegramUpdateId: "1",
  sourceRef: "123:1",
  rawText: "收到還款",
  receivedAt: "2026-09-24T01:00:00.000Z",
};

// 建立一筆已確認的代墊交易，只含單一筆 purpose=advance 的配置。
function confirmedAdvance(params: {
  readonly allocationId: string;
  readonly occurredDate: string;
  readonly amount: string;
  readonly counterpartyId?: string;
  readonly category?: string;
}): ConfirmedTransaction {
  const counterpartyId = params.counterpartyId ?? "counterparty-1";
  const category = params.category ?? "餐飲";
  return ConfirmedTransactionSchema.parse({
    transactionId: `transaction-${params.allocationId}`,
    draftId: `draft-${params.allocationId}`,
    ownerId: "owner-1",
    requestId: `request-${params.allocationId}`,
    sourceEventId: "seed-event",
    occurredDate: params.occurredDate,
    amount: { amount: params.amount, currency: "TWD" },
    allocations: [
      {
        allocationId: params.allocationId,
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: params.amount, currency: "TWD" },
        category,
        counterpartyId,
      },
    ],
    confirmedAt: `${params.occurredDate}T00:00:00.000Z`,
    status: "confirmed",
  });
}

function buildDependencies(repository: FakeLedgerRepository): {
  dependencies: RecordRecoveryDependencies;
  repository: FakeLedgerRepository;
} {
  let counter = 0;
  return {
    repository,
    dependencies: {
      repository,
      generateId: () => `id-${String(++counter)}`,
      incomeCategoryIds: ["category-income-other"],
    },
  };
}

function setupTwoAdvances() {
  const repository = new FakeLedgerRepository();
  repository.transactions.set(
    "request-A1",
    confirmedAdvance({ allocationId: "A1", occurredDate: "2026-09-10", amount: "100" }),
  );
  repository.transactions.set(
    "request-A2",
    confirmedAdvance({ allocationId: "A2", occurredDate: "2026-09-15", amount: "200" }),
  );
  return buildDependencies(repository);
}

function setupSingleAdvance(amount: string) {
  const repository = new FakeLedgerRepository();
  repository.transactions.set(
    "request-single",
    confirmedAdvance({ allocationId: "single-advance", occurredDate: "2026-09-10", amount }),
  );
  return buildDependencies(repository);
}

function setupNoAdvances() {
  const repository = new FakeLedgerRepository();
  return buildDependencies(repository);
}

describe("recordRecovery", () => {
  it("allocates one payment across two advances oldest first", async () => {
    const { dependencies, repository } = setupTwoAdvances();

    const result = await recordRecovery({ ...baseCommand, received: "300" }, dependencies);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.amount.amount).toBe("300");
    expect(
      result.draft.allocations.map((item) => [item.amount.amount, item.recoversAllocationId]),
    ).toEqual([
      ["100", "A1"],
      ["200", "A2"],
    ]);
    expect(repository.drafts.size).toBe(1);
  });

  it("keeps the recovery partial when the payment is smaller", async () => {
    const { dependencies } = setupTwoAdvances();

    const result = await recordRecovery({ ...baseCommand, received: "150" }, dependencies);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations.map((item) => item.amount.amount)).toEqual(["100", "50"]);
  });

  it("asks for a category when the payment exceeds the outstanding total", async () => {
    const { dependencies } = setupSingleAdvance("630");

    const result = await recordRecovery({ ...baseCommand, received: "700" }, dependencies);

    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") return;
    expect(result.surplus).toBe("70");
    expect(result.draft.pendingFields[0]?.field).toBe("category");
    expect(result.draft.partial.allocations.map((item) => item.amount?.amount)).toEqual([
      "630",
      "70",
    ]);
  });

  it("reports when the counterparty has nothing outstanding", async () => {
    const { dependencies } = setupNoAdvances();

    const result = await recordRecovery({ ...baseCommand, received: "100" }, dependencies);

    expect(result).toEqual({ kind: "no_outstanding" });
  });

  it("inherits the category and counterparty of the advance it recovers", async () => {
    const { dependencies } = setupSingleAdvance("630");

    const result = await recordRecovery({ ...baseCommand, received: "300" }, dependencies);

    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.allocations[0]).toMatchObject({
      category: "餐飲",
      counterpartyId: "counterparty-1",
      purpose: "advance_recovery",
      fundsEffect: "inflow",
    });
  });
});
