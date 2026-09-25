import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";
import type { TransactionDraft } from "../../src/domain/ledger.js";
import { seedM1Ledger } from "../fixtures/m1-ledger.js";

const draft: TransactionDraft = {
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
};

// 建立一筆含代墊配置的已確認交易，再確認一筆帶 recoversAllocationId 的回收草稿，
// 用於驗證 recovers_allocation_id 欄位的讀寫往返。
// 注意：confirmDraft 內部以 randomUUID() 產生 transactionId，無法指定為固定字串，
// 因此改為回傳實際產生的 recoveryTransactionId 供測試查詢。
async function setupConfirmedAdvance(): Promise<{
  repository: SqliteLedgerRepository;
  recoveryTransactionId: string;
}> {
  const advanceDatabase = openDatabase(":memory:");
  migrate(advanceDatabase);
  const repository = new SqliteLedgerRepository(advanceDatabase);

  advanceDatabase
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
    rawText: "代墊 120",
    receivedAt: "2026-09-24T01:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "advance-draft",
    ownerId: "owner-1",
    requestId: "advance-request",
    sourceEventId: "advance-event",
    occurredDate: "2026-09-24",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: "advance-allocation",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "120", currency: "TWD" },
        category: "代墊",
        counterpartyId: "counterparty-1",
      },
    ],
    status: "awaiting_confirmation",
  });
  await repository.confirmDraft("advance-draft", "2026-09-24T01:01:00.000Z", "advance-audit");

  await repository.recordInputEvent({
    eventId: "recovery-event",
    ownerId: "owner-1",
    telegramUpdateId: "recovery-update",
    sourceType: "telegram",
    sourceRef: "recovery-message",
    rawText: "代墊回收 120",
    receivedAt: "2026-09-24T02:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "recovery-draft",
    ownerId: "owner-1",
    requestId: "recovery-request",
    sourceEventId: "recovery-event",
    occurredDate: "2026-09-24",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: "recovery-allocation",
        fundsEffect: "inflow",
        purpose: "advance_recovery",
        amount: { amount: "120", currency: "TWD" },
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

  return { repository, recoveryTransactionId: recovery.transactionId };
}

describe("SqliteLedgerRepository", () => {
  let database: Database.Database;
  let repository: SqliteLedgerRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteLedgerRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  it("records a Telegram input event only once", async () => {
    const input = {
      eventId: "event-1",
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceType: "telegram" as const,
      sourceRef: "message-1",
      rawText: "午餐 120",
      receivedAt: "2026-09-18T01:00:00.000Z",
    };

    await expect(repository.recordInputEvent(input)).resolves.toEqual({
      created: true,
      eventId: "event-1",
    });
    await expect(
      repository.recordInputEvent({ ...input, eventId: "event-duplicate" }),
    ).resolves.toEqual({
      created: false,
      eventId: "event-1",
    });
  });

  it("confirms a draft atomically and idempotently", async () => {
    await repository.recordInputEvent({
      eventId: "event-1",
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceType: "telegram",
      sourceRef: "message-1",
      rawText: "午餐 120",
      receivedAt: "2026-09-18T01:00:00.000Z",
    });
    await repository.saveDraft(draft);

    const first = await repository.confirmDraft("draft-1", "2026-09-18T01:01:00.000Z", "audit-1");
    const second = await repository.confirmDraft("draft-1", "2026-09-18T01:02:00.000Z", "audit-2");

    expect(second.transactionId).toBe(first.transactionId);
    expect(second.confirmedAt).toBe(first.confirmedAt);
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({
      count: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM allocations").get()).toEqual({
      count: 1,
    });
    await expect(repository.getDraft("draft-1")).resolves.toMatchObject({
      status: "confirmed",
    });
    await expect(repository.listRecent("123", 10)).resolves.toEqual([first]);
    await expect(repository.listAuditEvents("123", first.transactionId)).resolves.toMatchObject([
      { action: "transaction_created", before: null, after: first },
    ]);
  });

  it("rolls back confirmation when creation audit cannot be written", async () => {
    await repository.recordInputEvent({
      eventId: "event-1",
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceType: "telegram",
      sourceRef: "message-1",
      rawText: "午餐 120",
      receivedAt: "2026-09-18T01:00:00.000Z",
    });
    await repository.saveDraft(draft);
    database.exec(`CREATE TRIGGER reject_creation_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'transaction_created' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END`);

    expect(() => repository.confirmDraft("draft-1", "2026-09-18T01:01:00.000Z", "audit-1")).toThrow(
      "audit blocked",
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM allocations").get()).toEqual({
      count: 0,
    });
    await expect(repository.getDraft("draft-1")).resolves.toMatchObject({
      status: "awaiting_confirmation",
    });
  });

  it("updates and soft-deletes a transaction with optimistic locking and audit", async () => {
    await repository.recordInputEvent({
      eventId: "event-1",
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceType: "telegram",
      sourceRef: "message-1",
      rawText: "午餐 120",
      receivedAt: "2026-09-18T01:00:00.000Z",
    });
    await repository.saveDraft(draft);
    const original = await repository.confirmDraft(
      "draft-1",
      "2026-09-18T01:01:00.000Z",
      "audit-create",
    );
    await repository.recordInputEvent({
      eventId: "edit-event",
      ownerId: "123",
      telegramUpdateId: "update-edit",
      sourceType: "telegram",
      sourceRef: "message-edit",
      rawText: "改成晚餐",
      receivedAt: "2026-09-18T02:00:00.000Z",
    });
    const updated = await repository.updateTransaction({
      ownerId: "123",
      transactionId: original.transactionId,
      sourceEventId: "edit-event",
      auditEventId: "audit-update",
      expectedUpdatedAt: original.updatedAt ?? "",
      replacement: { ...original, note: "與朋友晚餐" },
      changedAt: "2026-09-18T02:00:00.000Z",
    });
    expect(updated).toMatchObject({ note: "與朋友晚餐", updatedAt: "2026-09-18T02:00:00.000Z" });
    expect(() =>
      repository.updateTransaction({
        ownerId: "123",
        transactionId: original.transactionId,
        sourceEventId: "edit-event",
        auditEventId: "audit-stale",
        expectedUpdatedAt: original.updatedAt ?? "",
        replacement: original,
        changedAt: "2026-09-18T03:00:00.000Z",
      }),
    ).toThrow("stale transaction update");
    expect(() =>
      repository.softDeleteTransaction({
        ownerId: "other",
        transactionId: original.transactionId,
        sourceEventId: "edit-event",
        auditEventId: "audit-other",
        expectedUpdatedAt: updated.updatedAt ?? "",
        changedAt: "2026-09-18T03:00:00.000Z",
      }),
    ).toThrow("transaction not found for owner");
    const deleted = await repository.softDeleteTransaction({
      ownerId: "123",
      transactionId: original.transactionId,
      sourceEventId: "edit-event",
      auditEventId: "audit-delete",
      expectedUpdatedAt: updated.updatedAt ?? "",
      changedAt: "2026-09-18T03:00:00.000Z",
    });
    expect(deleted).toMatchObject({ status: "deleted", deletedAt: "2026-09-18T03:00:00.000Z" });
    expect(() =>
      repository.softDeleteTransaction({
        ownerId: "123",
        transactionId: original.transactionId,
        sourceEventId: "edit-event",
        auditEventId: "audit-delete-twice",
        expectedUpdatedAt: deleted.updatedAt ?? "",
        changedAt: "2026-09-18T04:00:00.000Z",
      }),
    ).toThrow("deleted transaction cannot be mutated");
    await expect(repository.listRecent("123", 10)).resolves.toEqual([]);
    await expect(repository.listAuditEvents("123", original.transactionId)).resolves.toMatchObject([
      { action: "transaction_created" },
      { action: "transaction_updated", before: original, after: updated },
      { action: "transaction_deleted", before: updated, after: deleted },
    ]);
  });

  it("links a refund to an expense and audits unlinking", async () => {
    for (const input of [
      { eventId: "event-1", telegramUpdateId: "update-1", rawText: "午餐 120" },
      { eventId: "refund-event", telegramUpdateId: "update-2", rawText: "退款 120" },
      { eventId: "link-event", telegramUpdateId: "update-3", rawText: "連結退款" },
    ])
      await repository.recordInputEvent({
        ...input,
        ownerId: "123",
        sourceType: "telegram",
        sourceRef: input.eventId,
        receivedAt: "2026-09-18T01:00:00.000Z",
      });
    await repository.saveDraft(draft);
    await repository.saveDraft({
      ...draft,
      draftId: "refund-draft",
      requestId: "refund-request",
      sourceEventId: "refund-event",
      allocations: [
        {
          allocationId: "refund-allocation",
          amount: { amount: "120", currency: "TWD" },
          category: "餐飲",
          subcategory: "午餐",
          fundsEffect: "inflow",
          purpose: "refund",
        },
      ],
    });
    const expense = await repository.confirmDraft(
      "draft-1",
      "2026-09-18T01:01:00.000Z",
      "audit-expense",
    );
    const refund = await repository.confirmDraft(
      "refund-draft",
      "2026-09-18T01:02:00.000Z",
      "audit-refund",
    );
    const command = {
      linkId: "refund-link",
      ownerId: "123",
      fromTransactionId: refund.transactionId,
      toTransactionId: expense.transactionId,
      linkType: "refund_of" as const,
      sourceEventId: "link-event",
      changedAt: "2026-09-18T01:03:00.000Z",
    };
    await repository.linkTransaction({ ...command, auditEventId: "audit-link" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transaction_links").get()).toEqual({
      count: 1,
    });
    await repository.unlinkTransaction({ ...command, auditEventId: "audit-unlink" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM transaction_links").get()).toEqual({
      count: 0,
    });
    await expect(repository.listAuditEvents("123", refund.transactionId)).resolves.toMatchObject([
      { action: "transaction_created" },
      { action: "transaction_linked" },
      { action: "transaction_unlinked" },
    ]);
  });

  it("cancels a draft without creating a transaction", async () => {
    await repository.recordInputEvent({
      eventId: "event-1",
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceType: "telegram",
      sourceRef: "message-1",
      rawText: "午餐 120",
      receivedAt: "2026-09-18T01:00:00.000Z",
    });
    await repository.saveDraft(draft);

    const cancelled = await repository.cancelDraft("draft-1");

    expect(cancelled.status).toBe("cancelled");
    expect(database.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({
      count: 0,
    });
  });

  it("round-trips the recovery reference on an allocation", async () => {
    const { repository: advanceRepository, recoveryTransactionId } = await setupConfirmedAdvance();

    const transaction = await advanceRepository.getTransaction("owner-1", recoveryTransactionId);

    expect(transaction?.allocations[0]?.recoversAllocationId).toBe("advance-allocation");
  });
  it("reuses the migrated 餐飲 category for an allocation that carries no categoryId", async () => {
    // 必須用「由 M1 升級上來」的資料庫，這才是 id 會分岔的場景：migration 0002 建的
    // category_id 是 'm2:<owner>:expense_dining_lunch'，0006 只改 key／name，而全新安裝
    // 由 bootstrap 種的是 'm2:<owner>:expense_dining'。ensureLegacyCategory 若直接組 id
    // 再 INSERT OR IGNORE，在升級過的帳本上會被 UNIQUE (owner_id, key) 靜靜吃掉並回傳
    // 一個不存在的 id，緊接著的 allocation 寫入就踩外鍵。
    // （全新安裝兩邊組出來的 id 相同，測不出這個分岔。）
    const upgraded = openDatabase(":memory:");
    try {
      seedM1Ledger(upgraded);
      migrate(upgraded);
      const upgradedRepository = new SqliteLedgerRepository(upgraded);
      const migrated = upgraded
        .prepare("SELECT category_id FROM categories WHERE owner_id = ? AND key = ?")
        .get("owner-1", "expense_dining") as { category_id: string };
      expect(migrated.category_id).toBe("m2:owner-1:expense_dining_lunch");

      await upgradedRepository.recordInputEvent({
        eventId: "upgrade-event",
        ownerId: "owner-1",
        telegramUpdateId: "upgrade-update",
        sourceType: "telegram",
        sourceRef: "upgrade-message",
        rawText: "午餐 120",
        receivedAt: "2026-09-26T01:00:00.000Z",
      });
      await upgradedRepository.saveDraft({
        ...draft,
        draftId: "upgrade-draft",
        ownerId: "owner-1",
        requestId: "upgrade-request",
        sourceEventId: "upgrade-event",
      });
      const confirmed = await upgradedRepository.confirmDraft(
        "upgrade-draft",
        "2026-09-26T01:01:00.000Z",
        "upgrade-audit",
      );

      expect(
        upgraded
          .prepare("SELECT category_id FROM allocations WHERE transaction_id = ?")
          .get(confirmed.transactionId),
      ).toEqual({ category_id: migrated.category_id });
      expect(
        upgraded
          .prepare("SELECT count(*) AS total FROM categories WHERE owner_id = ? AND key = ?")
          .get("owner-1", "expense_dining"),
      ).toEqual({ total: 1 });
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
  });
});
