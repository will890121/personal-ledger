import { describe, expect, it } from "vitest";

import { FakeLedgerRepository } from "./fake-ledger-repository.js";

const LATER = "2026-09-30T10:00:00.000Z";
const NOW = "2026-09-30T09:00:00.000Z";

// 這個檔案只測 FakeLedgerRepository 的 outbox 語意是否與 SqliteLedgerRepository 一致
// （見 tests/db/sqlite-outbox.test.ts）。本專案曾被測試替身與真實實作漂移咬過兩次，
// 這裡把四個最容易漂移的行為釘死：lease 未過期就擋住重新取得、markOutboxFailed
// 清空 lease 並把 attempts 加一、retryOutboxNeedsAttention 把 attempts 歸零、
// 三個 markOutbox* 的 lease 樂觀鎖（對應真實 SQL 的 `lease_expires_at IS ?`）。
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

    await repository.markOutboxFailed("failing", LATER, "Bad Gateway", LATER);

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
    await repository.markOutboxNeedsAttention("stuck", "Forbidden", null);

    await expect(repository.retryOutboxNeedsAttention("owner-1", LATER)).resolves.toBe(1);

    const row = repository.outboxMessages.get("stuck");
    expect(row).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: LATER });
  });

  it("refuses a mark whose lease token is no longer the row's", async () => {
    // 與 SqliteLedgerRepository 的 `lease_expires_at IS ?` 逐字對齊：過期的 worker
    // 蓋不掉接手者的結果，而 null 是一個真正的版本值（「沒有人租走這一列」），
    // 不是「不檢查」。這兩條語意只要有一條漂掉，runner 的並發測試就會在替身上
    // 看起來正常、在真的 SQLite 上出錯。
    const repository = new FakeLedgerRepository();
    repository.seedOutboxMessage({
      messageId: "racy",
      ownerId: "owner-1",
      cause: "transaction_confirmed",
      chatId: "55",
      text: "已入帳",
      nextAttemptAt: NOW,
    });
    const staleLease = "2026-09-30T09:00:30.000Z";
    await repository.claimDueOutbox("owner-1", NOW, staleLease, 10);
    await repository.claimDueOutbox("owner-1", "2026-09-30T09:00:31.000Z", LATER, 10);

    // 接手的 worker（lease = LATER）寫得進去；過期的那個（lease = staleLease）寫不進去。
    await expect(repository.markOutboxDelivered("racy", LATER, LATER)).resolves.toBe(true);
    await expect(
      repository.markOutboxNeedsAttention("racy", "Forbidden", staleLease),
    ).resolves.toBe(false);
    await expect(
      repository.markOutboxFailed("racy", LATER, "Bad Gateway", staleLease),
    ).resolves.toBe(false);
    expect(repository.outboxMessages.get("racy")).toMatchObject({
      status: "delivered",
      attempts: 0,
    });

    // 沒有被租走的列，null 才是對得上的版本值。
    await expect(repository.markOutboxNeedsAttention("racy", "Forbidden", null)).resolves.toBe(
      true,
    );
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
