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

    const first = await repository.confirmDraft("draft-1", "2026-09-18T01:01:00.000Z");
    const second = await repository.confirmDraft("draft-1", "2026-09-18T01:02:00.000Z");

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
