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
  occurredDate: "2026-09-30",
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

describe("confirmDraft writes the ledger change and its message together", () => {
  let database: Database.Database;
  let repository: SqliteLedgerRepository;

  beforeEach(async () => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteLedgerRepository(database);
    await repository.recordInputEvent({
      eventId: "event-1",
      ownerId: "123",
      telegramUpdateId: "update-1",
      sourceType: "telegram",
      sourceRef: "message-1",
      rawText: "午餐 120",
      receivedAt: "2026-09-30T01:00:00.000Z",
    });
    await repository.saveDraft(draft);
  });
  afterEach(() => database.close());

  function outbox(messageId = "outbox-1") {
    return {
      messageId,
      cause: "transaction_confirmed" as const,
      render: (confirmed: { transactionId: string }) => ({
        chatId: "55",
        targetMessageId: "77",
        text: `已入帳：交易 ID ${confirmed.transactionId}`,
      }),
    };
  }

  it("stores a pending message rendered from the committed transaction", async () => {
    const confirmed = await repository.confirmDraft(
      "draft-1",
      "2026-09-30T01:01:00.000Z",
      "audit-1",
      outbox(),
    );

    const row = database.prepare("SELECT * FROM outbox_messages").get() as {
      status: string;
      text: string;
      chat_id: string;
      target_message_id: string;
      attempts: number;
      created_at: string;
    };
    // 渲染函式必須在 transaction 內、交易產生之後被呼叫，否則拿不到 transactionId。
    expect(row.text).toBe(`已入帳：交易 ID ${confirmed.transactionId}`);
    expect(row).toMatchObject({
      status: "pending",
      chat_id: "55",
      target_message_id: "77",
      attempts: 0,
    });
    // created_at 必須是明寫的 ISO 字串。少了這條斷言，把它從 INSERT 拿掉讓欄位落到
    // DEFAULT CURRENT_TIMESTAMP（`YYYY-MM-DD HH:MM:SS`）整份測試仍然全綠，而
    // summarizeOutbox 的 oldestPendingAt 讀的就是這個欄位。
    expect(row.created_at).toBe("2026-09-30T01:01:00.000Z");
  });

  it("leaves no message behind when the ledger write fails", () => {
    // 原子性的另一半：交易沒成立就不該有待送訊息。
    // confirmDraft 內部經由 database.transaction(...).immediate() 執行，失敗時是同步
    // 重新拋出，而不是回傳被拒絕的 Promise——與 tests/db/sqlite-ledger-repository.test.ts
    // 的 "audit blocked" 案例、tests/db/sqlite-advances.test.ts 的說明一致，因此這裡用
    // 同步 throw 斷言，不是 `await expect(...).rejects.toThrow(...)`。
    expect(() =>
      repository.confirmDraft(
        "draft-missing",
        "2026-09-30T01:01:00.000Z",
        "audit-2",
        outbox("outbox-2"),
      ),
    ).toThrow(/draft not found/);

    expect(database.prepare("SELECT count(*) AS total FROM outbox_messages").get()).toEqual({
      total: 0,
    });
  });

  it("does not queue a second message when the same draft is confirmed twice", async () => {
    // 重複 callback：一筆交易、一列 outbox。
    const first = await repository.confirmDraft(
      "draft-1",
      "2026-09-30T01:01:00.000Z",
      "audit-1",
      outbox("outbox-a"),
    );
    const second = await repository.confirmDraft(
      "draft-1",
      "2026-09-30T01:02:00.000Z",
      "audit-2",
      outbox("outbox-b"),
    );

    expect(second.transactionId).toBe(first.transactionId);
    expect(database.prepare("SELECT count(*) AS total FROM transactions").get()).toEqual({
      total: 1,
    });
    expect(database.prepare("SELECT count(*) AS total FROM outbox_messages").get()).toEqual({
      total: 1,
    });
  });
});
