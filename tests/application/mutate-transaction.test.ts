import { describe, expect, it } from "vitest";

import {
  softDeleteConfirmedTransaction,
  updateConfirmedTransaction,
} from "../../src/application/mutate-transaction.js";
import type { ConfirmedTransaction } from "../../src/domain/ledger.js";
import { FakeLedgerRepository } from "../support/fake-ledger-repository.js";

const transaction: ConfirmedTransaction = {
  transactionId: "transaction-1",
  draftId: "draft-1",
  ownerId: "123",
  requestId: "request-1",
  sourceEventId: "create-event",
  occurredDate: "2026-09-18",
  amount: { amount: "120", currency: "TWD" },
  allocations: [
    {
      allocationId: "allocation-1",
      fundsEffect: "outflow",
      purpose: "expense",
      amount: { amount: "120", currency: "TWD" },
      category: "餐飲",
    },
  ],
  confirmedAt: "2026-09-18T01:00:00.000Z",
  createdAt: "2026-09-18T01:00:00.000Z",
  updatedAt: "2026-09-18T01:00:00.000Z",
  status: "confirmed",
};

function inputEvent(eventId: string) {
  return {
    eventId,
    ownerId: "123",
    telegramUpdateId: `update-${eventId}`,
    sourceType: "telegram" as const,
    sourceRef: `message-${eventId}`,
    rawText: "修改交易",
    receivedAt: "2026-09-18T02:00:00.000Z",
  };
}

describe("transaction mutation services", () => {
  it("records the immutable input before updating", async () => {
    const calls: string[] = [];
    const repository = new FakeLedgerRepository();
    repository.transactions.set(transaction.requestId, transaction);
    const record = repository.recordInputEvent.bind(repository);
    repository.recordInputEvent = async (input) => {
      calls.push("input");
      return record(input);
    };
    const update = repository.updateTransaction.bind(repository);
    repository.updateTransaction = async (command) => {
      calls.push("update");
      return update(command);
    };

    await updateConfirmedTransaction(
      {
        ownerId: "123",
        transactionId: "transaction-1",
        sourceEventId: "edit-event",
        auditEventId: "audit-update",
        expectedUpdatedAt: transaction.updatedAt ?? "",
        replacement: { ...transaction, note: "更新" },
        changedAt: "2026-09-18T02:00:00.000Z",
      },
      { repository, inputEvent: inputEvent("edit-event") },
    );

    expect(calls).toEqual(["input", "update"]);
  });

  it("records the immutable input before soft deletion", async () => {
    const calls: string[] = [];
    const repository = new FakeLedgerRepository();
    repository.transactions.set(transaction.requestId, transaction);
    const record = repository.recordInputEvent.bind(repository);
    repository.recordInputEvent = async (input) => {
      calls.push("input");
      return record(input);
    };
    const remove = repository.softDeleteTransaction.bind(repository);
    repository.softDeleteTransaction = async (command) => {
      calls.push("delete");
      return remove(command);
    };

    await softDeleteConfirmedTransaction(
      {
        ownerId: "123",
        transactionId: "transaction-1",
        sourceEventId: "delete-event",
        auditEventId: "audit-delete",
        expectedUpdatedAt: transaction.updatedAt ?? "",
        changedAt: "2026-09-18T02:00:00.000Z",
      },
      { repository, inputEvent: inputEvent("delete-event") },
    );

    expect(calls).toEqual(["input", "delete"]);
  });
});
