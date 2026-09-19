import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";
import type { TransactionDraft } from "../../src/domain/ledger.js";

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
});
