import { describe, expect, it } from "vitest";

import { FakeLedgerRepository } from "./fake-ledger-repository.js";

const LATER = "2026-09-30T10:00:00.000Z";
const NOW = "2026-09-30T09:00:00.000Z";

// 這個檔案只測 FakeLedgerRepository 的 outbox 語意是否與 SqliteLedgerRepository 一致
// （見 tests/db/sqlite-outbox.test.ts）。本專案曾被測試替身與真實實作漂移咬過兩次，
// 這裡把三個最容易漂移的行為釘死：lease 未過期就擋住重新取得、markOutboxFailed
// 清空 lease 並把 attempts 加一、retryOutboxNeedsAttention 把 attempts 歸零。
describe("FakeLedgerRepository outbox semantics", () => {
  it("blocks re-claiming while the lease has not expired", async () => {
    const repository = new FakeLedgerRepository();
    repository.seedOutboxMessage({
      messageId: "due",
      ownerId: "owner-1",
      cause: "transaction_confirmed",
      chatId: "55",
      text: "已入帳",
      nextAttemptAt: NOW,
    });

    const claimed = await repository.claimDueOutbox("owner-1", NOW, LATER, 10);
    expect(claimed.map((item) => item.messageId)).toEqual(["due"]);

    // 同一列已經被租下，lease 還沒過期，第二次不該再拿到。
    await expect(repository.claimDueOutbox("owner-1", NOW, LATER, 10)).resolves.toEqual([]);

    // lease 過期之後才能重新取得——這是「啟動恢復」語意。
    await expect(repository.claimDueOutbox("owner-1", LATER, LATER, 10)).resolves.toHaveLength(1);
  });

  it("clears the lease and increments attempts when delivery fails", async () => {
    const repository = new FakeLedgerRepository();
    repository.seedOutboxMessage({
      messageId: "failing",
      ownerId: "owner-1",
      cause: "transaction_confirmed",
      chatId: "55",
      text: "已入帳",
      nextAttemptAt: NOW,
    });
    await repository.claimDueOutbox("owner-1", NOW, LATER, 10);

    await repository.markOutboxFailed("failing", LATER, "Bad Gateway");

    const row = repository.outboxMessages.get("failing");
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBe(LATER);
    // lease 必須釋放，否則重試要等 lease 自然過期。
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.lastError).toBe("Bad Gateway");

    // lease 已清空，失敗後的訊息應該能立刻依新排程再次被取得。
    await expect(repository.claimDueOutbox("owner-1", LATER, LATER, 10)).resolves.toHaveLength(1);
  });

  it("resets attempts to 0 when a needs-attention message is retried", async () => {
    const repository = new FakeLedgerRepository();
    repository.seedOutboxMessage({
      messageId: "stuck",
      ownerId: "owner-1",
      cause: "transaction_confirmed",
      chatId: "55",
      text: "已入帳",
      nextAttemptAt: NOW,
      attempts: 4,
    });
    await repository.markOutboxNeedsAttention("stuck", "Forbidden");

    await expect(repository.retryOutboxNeedsAttention("owner-1", LATER)).resolves.toBe(1);

    const row = repository.outboxMessages.get("stuck");
    expect(row).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: LATER });
  });

  it("reports oldestPendingAt as when the message was queued, not when it is next due", async () => {
    const repository = new FakeLedgerRepository();
    const queuedAt = "2026-09-30T08:00:00.000Z";
    const nextAttemptAt = "2026-09-30T11:00:00.000Z";
    repository.seedOutboxMessage({
      messageId: "backing-off",
      ownerId: "owner-1",
      cause: "transaction_confirmed",
      chatId: "55",
      text: "已入帳",
      nextAttemptAt,
      attempts: 1,
      createdAt: queuedAt,
    });

    await expect(repository.summarizeOutbox("owner-1")).resolves.toMatchObject({
      oldestPendingAt: queuedAt,
    });
  });
});
