import { describe, expect, it } from "vitest";

import { listAdvances } from "../../src/application/list-advances.js";
import { ConfirmedTransactionSchema } from "../../src/domain/ledger.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";
import { FakeReferenceRepository } from "../support/fake-reference-repository.js";

function setupTwoCounterparties() {
  const repository = new FakeLedgerRepository();
  const referenceRepository = new FakeReferenceRepository();

  // 建立交易對象
  referenceRepository.counterparties.push({
    counterpartyId: "xiaoming",
    ownerId: "owner-1",
    name: "小明",
    active: true,
  });
  referenceRepository.counterparties.push({
    counterpartyId: "xiaohua",
    ownerId: "owner-1",
    name: "小華",
    active: true,
  });

  // 建立三筆交易，向小明代墊 2 筆（共 500），向小華代墊 1 筆（200）
  // 小明交易 1: 300 元代墊
  const tx1 = ConfirmedTransactionSchema.parse({
    requestId: "req-1",
    draftId: "draft-1",
    transactionId: "tx-1",
    ownerId: "owner-1",
    sourceEventId: "event-1",
    occurredDate: "2026-09-20",
    amount: { amount: "300", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-20T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-1-1",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "300", currency: "TWD" },
        counterpartyId: "xiaoming",
        category: "餐飲",
      },
    ],
  });

  // 小明交易 2: 200 元代墊
  const tx2 = ConfirmedTransactionSchema.parse({
    requestId: "req-2",
    draftId: "draft-2",
    transactionId: "tx-2",
    ownerId: "owner-1",
    sourceEventId: "event-2",
    occurredDate: "2026-09-21",
    amount: { amount: "200", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-21T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-2-1",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "200", currency: "TWD" },
        counterpartyId: "xiaoming",
        category: "餐飲",
      },
    ],
  });

  // 小華交易: 200 元代墊
  const tx3 = ConfirmedTransactionSchema.parse({
    requestId: "req-3",
    draftId: "draft-3",
    transactionId: "tx-3",
    ownerId: "owner-1",
    sourceEventId: "event-3",
    occurredDate: "2026-09-22",
    amount: { amount: "200", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-22T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-3-1",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "200", currency: "TWD" },
        counterpartyId: "xiaohua",
        category: "餐飲",
      },
    ],
  });

  repository.transactions.set("req-1", tx1);
  repository.transactions.set("req-2", tx2);
  repository.transactions.set("req-3", tx3);

  return Promise.resolve({ repository, referenceRepository });
}

function setupFullyRecovered() {
  const repository = new FakeLedgerRepository();
  const referenceRepository = new FakeReferenceRepository();

  referenceRepository.counterparties.push({
    counterpartyId: "xiaoming",
    ownerId: "owner-1",
    name: "小明",
    active: true,
  });

  // 代墊交易
  const txAdvance = ConfirmedTransactionSchema.parse({
    requestId: "req-advance",
    draftId: "draft-advance",
    transactionId: "tx-advance",
    ownerId: "owner-1",
    sourceEventId: "event-advance",
    occurredDate: "2026-09-20",
    amount: { amount: "500", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-20T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-advance",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "500", currency: "TWD" },
        counterpartyId: "xiaoming",
        category: "餐飲",
      },
    ],
  });

  // 完全回收交易
  const txRecovery = ConfirmedTransactionSchema.parse({
    requestId: "req-recovery",
    draftId: "draft-recovery",
    transactionId: "tx-recovery",
    ownerId: "owner-1",
    sourceEventId: "event-recovery",
    occurredDate: "2026-09-21",
    amount: { amount: "500", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-21T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-recovery",
        fundsEffect: "inflow",
        purpose: "advance_recovery",
        amount: { amount: "500", currency: "TWD" },
        recoversAllocationId: "alloc-advance",
        category: "收入",
      },
    ],
  });

  repository.transactions.set("req-advance", txAdvance);
  repository.transactions.set("req-recovery", txRecovery);

  return Promise.resolve({ repository, referenceRepository });
}

function setupUnknownCounterparty() {
  const repository = new FakeLedgerRepository();
  const referenceRepository = new FakeReferenceRepository();

  // 不在 referenceRepository 中的交易對象
  const tx = ConfirmedTransactionSchema.parse({
    requestId: "req-unknown",
    draftId: "draft-unknown",
    transactionId: "tx-unknown",
    ownerId: "owner-1",
    sourceEventId: "event-unknown",
    occurredDate: "2026-09-20",
    amount: { amount: "300", currency: "TWD" },
    status: "confirmed",
    confirmedAt: "2026-09-20T00:00:00.000Z",
    allocations: [
      {
        allocationId: "alloc-unknown",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "300", currency: "TWD" },
        counterpartyId: "counterparty-gone",
        category: "餐飲",
      },
    ],
  });

  repository.transactions.set("req-unknown", tx);

  return Promise.resolve({ repository, referenceRepository });
}

describe("list advances", () => {
  it("groups outstanding advances by counterparty", async () => {
    const { repository, referenceRepository } = await setupTwoCounterparties();

    const groups = await listAdvances(repository, referenceRepository, "owner-1");

    expect(groups.map((group) => [group.name, group.total, group.items.length])).toEqual([
      ["小明", "500", 2],
      ["小華", "200", 1],
    ]);
  });

  it("omits counterparties whose advances are fully recovered", async () => {
    const { repository, referenceRepository } = await setupFullyRecovered();

    expect(await listAdvances(repository, referenceRepository, "owner-1")).toEqual([]);
  });

  it("falls back to the counterparty id when the name is missing", async () => {
    const { repository, referenceRepository } = await setupUnknownCounterparty();

    const groups = await listAdvances(repository, referenceRepository, "owner-1");

    expect(groups[0]?.name).toBe("counterparty-gone");
  });
});
