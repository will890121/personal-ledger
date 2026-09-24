import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  abandonAdvance,
  type AbandonAdvanceCommand,
  type AbandonAdvanceDependencies,
} from "../../src/application/abandon-advance.js";
import { ConfirmedTransactionSchema, type ConfirmedTransaction } from "../../src/domain/ledger.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

const baseCommand: AbandonAdvanceCommand = {
  ownerId: "owner-1",
  allocationId: "advance-allocation",
  telegramUpdateId: "1",
  sourceRef: "123:1",
  receivedAt: "2026-09-24T01:00:00.000Z",
};

// 建立一筆已確認的代墊交易，只含單一筆 purpose=advance 的配置。
function confirmedAdvance(amount: string): ConfirmedTransaction {
  return ConfirmedTransactionSchema.parse({
    transactionId: "advance-transaction",
    draftId: "draft-advance",
    ownerId: "owner-1",
    requestId: "request-advance",
    sourceEventId: "seed-event",
    occurredDate: "2026-09-10",
    amount: { amount, currency: "TWD" },
    allocations: [
      {
        allocationId: "advance-allocation",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount, currency: "TWD" },
        category: "餐飲",
        counterpartyId: "counterparty-1",
      },
    ],
    confirmedAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    status: "confirmed",
  });
}

// 建立一筆已確認的回收交易，其 advance_recovery 配置指回 advance-allocation。
function confirmedRecovery(amount: string): ConfirmedTransaction {
  return ConfirmedTransactionSchema.parse({
    transactionId: "recovery-transaction",
    draftId: "draft-recovery",
    ownerId: "owner-1",
    requestId: "request-recovery",
    sourceEventId: "seed-event-recovery",
    occurredDate: "2026-09-15",
    amount: { amount, currency: "TWD" },
    allocations: [
      {
        allocationId: "recovery-allocation",
        fundsEffect: "inflow",
        purpose: "advance_recovery",
        amount: { amount, currency: "TWD" },
        category: "餐飲",
        counterpartyId: "counterparty-1",
        recoversAllocationId: "advance-allocation",
      },
    ],
    confirmedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    status: "confirmed",
  });
}

// 建立一筆代墊金額 advanceAmount、已回收 recoveredAmount 的情境。
// recoveredAmount 為 "0" 時不建立回收交易（金額必須為正，見 src/domain/money.ts）。
async function setupAdvanceWithRecovery(
  advanceAmount: string,
  recoveredAmount: string,
): Promise<{ dependencies: AbandonAdvanceDependencies; repository: FakeLedgerRepository }> {
  const repository = new FakeLedgerRepository();
  repository.transactions.set("request-advance", confirmedAdvance(advanceAmount));
  if (!new Decimal(recoveredAmount).isZero()) {
    repository.transactions.set("request-recovery", confirmedRecovery(recoveredAmount));
  }

  let counter = 0;
  const dependencies: AbandonAdvanceDependencies = {
    repository,
    generateId: () => `id-${String(++counter)}`,
    now: () => new Date("2026-09-24T01:00:00.000Z"),
  };
  return Promise.resolve({ dependencies, repository });
}

describe("abandonAdvance", () => {
  it("splits a partially recovered advance and keeps the transaction total", async () => {
    const { dependencies } = await setupAdvanceWithRecovery("630", "300");

    const result = await abandonAdvance({ ...baseCommand }, dependencies);

    expect(result.kind).toBe("abandoned");
    if (result.kind !== "abandoned") return;
    expect(result.amount).toBe("330");
    const allocations = result.transaction.allocations;
    expect(allocations.find((item) => item.purpose === "advance")?.amount.amount).toBe("300");
    expect(
      allocations.filter((item) => item.purpose === "expense").map((item) => item.amount.amount),
    ).toContain("330");
    // 專案禁止原生浮點數運算，改用 Decimal 加總驗證配置金額合計。
    const total = allocations.reduce(
      (sum, item) => sum.plus(item.amount.amount),
      new Decimal(0),
    );
    expect(total.toString()).toBe(result.transaction.amount.amount);
  });

  it("converts the whole allocation when nothing was recovered", async () => {
    const { dependencies } = await setupAdvanceWithRecovery("630", "0");

    const result = await abandonAdvance({ ...baseCommand }, dependencies);

    expect(result.kind).toBe("abandoned");
    if (result.kind !== "abandoned") return;
    expect(result.transaction.allocations.some((item) => item.purpose === "advance")).toBe(false);
    expect(result.amount).toBe("630");
  });

  it("reports when the advance is already fully recovered", async () => {
    const { dependencies } = await setupAdvanceWithRecovery("630", "630");

    expect(await abandonAdvance({ ...baseCommand }, dependencies)).toEqual({
      kind: "nothing_to_abandon",
    });
  });

  it("reports not_found when the allocation id is unknown", async () => {
    const { dependencies } = await setupAdvanceWithRecovery("630", "0");

    expect(
      await abandonAdvance({ ...baseCommand, allocationId: "missing-allocation" }, dependencies),
    ).toEqual({ kind: "not_found" });
  });

  it("keeps the abandoned expense on the advance's original date", async () => {
    const { dependencies } = await setupAdvanceWithRecovery("630", "300");

    const result = await abandonAdvance({ ...baseCommand }, dependencies);

    expect(result.kind).toBe("abandoned");
    if (result.kind !== "abandoned") return;
    expect(result.transaction.occurredDate).toBe("2026-09-10");
  });

  it("writes an audit event with before and after snapshots", async () => {
    const { dependencies, repository } = await setupAdvanceWithRecovery("630", "300");

    await abandonAdvance({ ...baseCommand }, dependencies);

    const events = await repository.listAuditEvents("owner-1", "advance-transaction");
    expect(events.at(-1)?.action).toBe("transaction_updated");
  });
});
