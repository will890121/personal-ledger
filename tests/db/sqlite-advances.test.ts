import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";
import type { DeleteTransactionCommand } from "../../src/ports/ledger-repository.js";

// 建立一筆已確認的代墊交易（含代墊配置），供代墊查詢與刪除保護測試使用。
// 注意：confirmDraft 內部以 randomUUID() 產生 transactionId，無法指定為固定字串，
// 因此回傳實際產生的 transactionId 供測試查詢使用。
async function setupAdvanceLedger(): Promise<{
  repository: SqliteLedgerRepository;
  transactionId: string;
  updatedAt: string;
}> {
  const database = openDatabase(":memory:");
  migrate(database);
  const repository = new SqliteLedgerRepository(database);

  database
    .prepare(
      "INSERT INTO counterparties (counterparty_id, owner_id, name, normalized_name) VALUES (?, ?, ?, ?)",
    )
    .run("counterparty-1", "owner-1", "朋友", "朋友");

  await repository.recordInputEvent({
    eventId: "advance-event",
    ownerId: "owner-1",
    telegramUpdateId: "advance-update",
    sourceType: "telegram",
    sourceRef: "advance-message",
    rawText: "代墊 630",
    receivedAt: "2026-09-24T01:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "advance-draft",
    ownerId: "owner-1",
    requestId: "advance-request",
    sourceEventId: "advance-event",
    occurredDate: "2026-09-24",
    amount: { amount: "630", currency: "TWD" },
    allocations: [
      {
        allocationId: "advance-allocation",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "630", currency: "TWD" },
        category: "代墊",
        counterpartyId: "counterparty-1",
      },
    ],
    status: "awaiting_confirmation",
  });
  const transaction = await repository.confirmDraft(
    "advance-draft",
    "2026-09-24T01:01:00.000Z",
    "advance-audit",
  );

  return {
    repository,
    transactionId: transaction.transactionId,
    updatedAt: transaction.updatedAt ?? "",
  };
}

// 在代墊之上加入一筆回收，回收金額由呼叫端指定，用於驗證回收查詢與刪除保護。
async function setupAdvanceLedgerWithRecovery(recoveryAmount: string): Promise<{
  repository: SqliteLedgerRepository;
  command: DeleteTransactionCommand;
  transactionId: string;
  recoveryTransactionId: string;
}> {
  const { repository, transactionId, updatedAt } = await setupAdvanceLedger();

  await repository.recordInputEvent({
    eventId: "recovery-event",
    ownerId: "owner-1",
    telegramUpdateId: "recovery-update",
    sourceType: "telegram",
    sourceRef: "recovery-message",
    rawText: `代墊回收 ${recoveryAmount}`,
    receivedAt: "2026-09-24T02:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "recovery-draft",
    ownerId: "owner-1",
    requestId: "recovery-request",
    sourceEventId: "recovery-event",
    occurredDate: "2026-09-24",
    amount: { amount: recoveryAmount, currency: "TWD" },
    allocations: [
      {
        allocationId: "recovery-allocation",
        fundsEffect: "inflow",
        purpose: "advance_recovery",
        amount: { amount: recoveryAmount, currency: "TWD" },
        category: "代墊回收",
        counterpartyId: "counterparty-1",
        recoversAllocationId: "advance-allocation",
      },
    ],
    status: "awaiting_confirmation",
  });
  const recovery = await repository.confirmDraft(
    "recovery-draft",
    "2026-09-24T02:01:00.000Z",
    "recovery-audit",
  );

  const command: DeleteTransactionCommand = {
    ownerId: "owner-1",
    transactionId,
    sourceEventId: "advance-event",
    auditEventId: "advance-delete-audit",
    expectedUpdatedAt: updatedAt,
    changedAt: "2026-09-24T03:00:00.000Z",
  };

  return {
    repository,
    command,
    transactionId,
    recoveryTransactionId: recovery.transactionId,
  };
}

// 在代墊與回收之上，將回收交易本身軟刪除，用於驗證查詢會排除已刪除的交易。
async function setupAdvanceLedgerWithDeletedRecovery(recoveryAmount: string): Promise<{
  repository: SqliteLedgerRepository;
}> {
  const { repository, recoveryTransactionId } =
    await setupAdvanceLedgerWithRecovery(recoveryAmount);

  const recovery = await repository.getTransaction("owner-1", recoveryTransactionId);
  await repository.softDeleteTransaction({
    ownerId: "owner-1",
    transactionId: recoveryTransactionId,
    sourceEventId: "recovery-event",
    auditEventId: "recovery-delete-audit",
    expectedUpdatedAt: recovery?.updatedAt ?? "",
    changedAt: "2026-09-24T04:00:00.000Z",
  });

  return { repository };
}

describe("advance queries", () => {
  it("lists advance rows with their reference data", async () => {
    const { repository } = await setupAdvanceLedger();

    const rows = await repository.listAdvanceRows("owner-1");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allocationId: "advance-allocation",
      counterpartyId: "counterparty-1",
      amount: "630",
      occurredDate: "2026-09-24",
    });
  });

  it("lists recovery rows as raw amounts", async () => {
    const { repository } = await setupAdvanceLedgerWithRecovery("300");

    const rows = await repository.listRecoveryRows("owner-1");

    expect(rows).toEqual([{ recoversAllocationId: "advance-allocation", amount: "300" }]);
  });

  it("excludes deleted transactions from both queries", async () => {
    const { repository } = await setupAdvanceLedgerWithDeletedRecovery("300");

    expect(await repository.listRecoveryRows("owner-1")).toEqual([]);
  });

  it("refuses to delete an advance transaction that still has recoveries", async () => {
    const { repository, command } = await setupAdvanceLedgerWithRecovery("300");

    // softDeleteTransaction 內部透過 better-sqlite3 的 database.transaction(...).immediate()
    // 執行，該呼叫在交易函式拋出錯誤時會「同步」重新拋出，而不是回傳被拒絕的 Promise。
    // 這與既有的 tests/db/sqlite-ledger-repository.test.ts（見 "stale transaction update" /
    // "transaction not found for owner" 案例）採用相同的同步 throw 斷言慣例，
    // 而非 `await expect(...).rejects.toThrow(...)`。
    expect(() => repository.softDeleteTransaction(command)).toThrow("advance still has recoveries");
  });

  it("counts recoveries pointing at a transaction", async () => {
    const { repository, transactionId } = await setupAdvanceLedgerWithRecovery("300");

    expect(await repository.countRecoveriesForTransaction("owner-1", transactionId)).toBe(1);
  });
});
