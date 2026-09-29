import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";

const LATER = "2026-09-30T10:00:00.000Z";
const NOW = "2026-09-30T09:00:00.000Z";

describe("outbox storage", () => {
  let database: Database.Database;
  let repository: SqliteLedgerRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrate(database);
    repository = new SqliteLedgerRepository(database);
  });
  afterEach(() => database.close());

  function seed(messageId: string, nextAttemptAt: string, replyMarkup?: string): void {
    // created_at 明確寫入，值與 next_attempt_at 相同：本專案所有時間都一律
    // new Date(...).toISOString()，讓 SQLite 的 DEFAULT CURRENT_TIMESTAMP（沒有毫秒、
    // 沒有 T/Z）偷偷混進資料列，正是這個 seed 曾經犯過的錯。
    database
      .prepare(
        `INSERT INTO outbox_messages
           (message_id, owner_id, cause, chat_id, target_message_id, text, reply_markup,
            status, next_attempt_at, created_at)
         VALUES (?, 'owner-1', 'transaction_confirmed', '55', '77', '已入帳', ?, 'pending', ?, ?)`,
      )
      .run(messageId, replyMarkup ?? null, nextAttemptAt, nextAttemptAt);
  }

  it("claims only rows that are due and not already leased", async () => {
    seed("due", NOW);
    seed("future", LATER);

    const claimed = await repository.claimDueOutbox("owner-1", NOW, LATER, 10);

    expect(claimed.map((item) => item.messageId)).toEqual(["due"]);
    // 取得 lease 之後，第二次撈不該再拿到同一列——這擋住快速路徑與背景迴圈同時送。
    await expect(repository.claimDueOutbox("owner-1", NOW, LATER, 10)).resolves.toEqual([]);
  });

  it("reclaims a row whose lease expired with the process that held it", async () => {
    // 這就是「啟動恢復」：死掉的行程留下過期 lease，沒有另一條開機路徑。
    seed("orphan", NOW);
    await repository.claimDueOutbox("owner-1", NOW, "2026-09-30T09:00:30.000Z", 10);

    const reclaimed = await repository.claimDueOutbox("owner-1", LATER, LATER, 10);

    expect(reclaimed.map((item) => item.messageId)).toEqual(["orphan"]);
  });

  it("round-trips the reply markup through JSON", async () => {
    // 按鈕壞掉在手動驗收之前沒有人會發現。
    const markup = JSON.stringify({
      inline_keyboard: [[{ text: "重試全部", callback_data: "outbox-retry" }]],
    });
    seed("with-buttons", NOW, markup);

    const [claimed] = await repository.claimDueOutbox("owner-1", NOW, LATER, 10);

    expect(claimed?.replyMarkup).toBe(markup);
    expect(JSON.parse(claimed?.replyMarkup ?? "{}")).toEqual({
      inline_keyboard: [[{ text: "重試全部", callback_data: "outbox-retry" }]],
    });
  });

  it("counts attempts up and schedules the next one when delivery fails", async () => {
    seed("failing", NOW);
    await repository.claimDueOutbox("owner-1", NOW, LATER, 10);

    await repository.markOutboxFailed("failing", LATER, "Bad Gateway");

    const row = database
      .prepare(
        "SELECT attempts, next_attempt_at, lease_expires_at, last_error FROM outbox_messages WHERE message_id = 'failing'",
      )
      .get() as {
      attempts: number;
      next_attempt_at: string;
      lease_expires_at: string | null;
      last_error: string;
    };
    expect(row).toEqual({
      attempts: 1,
      next_attempt_at: LATER,
      // lease 必須釋放，否則重試要等 lease 過期
      lease_expires_at: null,
      last_error: "Bad Gateway",
    });
  });

  it("compares schedule times as ISO strings with milliseconds", async () => {
    // SQLite 做字串比較。格式一旦混用（有的帶毫秒、有的不帶），排序就會錯，
    // 排程於是永遠不到期或立刻到期。所有時間一律 toISOString()。
    seed("due", "2026-09-30T09:00:00.000Z");
    // 不帶毫秒的 "2026-09-30T09:00:00Z" 字串大於帶毫秒的版本，若寫入端格式不一致，
    // 這一列就會被判成還沒到期。
    const nowWithoutMillis = "2026-09-30T09:00:00Z";

    await expect(
      repository.claimDueOutbox("owner-1", nowWithoutMillis, LATER, 10),
    ).resolves.toHaveLength(1);

    const stored = database
      .prepare("SELECT next_attempt_at FROM outbox_messages WHERE message_id = 'due'")
      .get() as { next_attempt_at: string };
    expect(stored.next_attempt_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("summarises what /status needs", async () => {
    seed("waiting", NOW);
    seed("done", NOW);
    await repository.markOutboxDelivered("done", LATER);
    seed("stuck", NOW);
    await repository.markOutboxNeedsAttention("stuck", "Forbidden");

    await expect(repository.summarizeOutbox("owner-1")).resolves.toMatchObject({
      pending: 1,
      needsAttention: 1,
      oldestPendingAt: NOW,
      lastDeliveredAt: LATER,
    });
  });

  it("reports oldestPendingAt as when the message was queued, not when it is next due", async () => {
    // 已經失敗過一次的訊息，next_attempt_at 因退避被推到未來；oldestPendingAt 回答的是
    // 「卡多久了」，也就是 created_at，不是下一次到期時間——否則 /status 會顯示負的
    // 等待分鐘數，看起來像還沒到期而不是卡住很久。
    const queuedAt = "2026-09-30T08:00:00.000Z";
    const nextAttemptAt = "2026-09-30T11:00:00.000Z";
    database
      .prepare(
        `INSERT INTO outbox_messages
           (message_id, owner_id, cause, chat_id, target_message_id, text, reply_markup,
            status, attempts, next_attempt_at, created_at)
         VALUES ('backing-off', 'owner-1', 'transaction_confirmed', '55', '77', '已入帳', NULL,
                 'pending', 1, ?, ?)`,
      )
      .run(nextAttemptAt, queuedAt);

    await expect(repository.summarizeOutbox("owner-1")).resolves.toMatchObject({
      oldestPendingAt: queuedAt,
    });
  });

  it("puts every stuck row back in the queue on request, resetting attempts", async () => {
    // seed()＋markOutboxNeedsAttention 留下的 attempts 本來就是 0：那樣分不出
    // 「歸零」跟「原封不動」，審查時把 UPDATE 裡的 attempts = 0 拿掉，整套仍全綠。
    // 直接插入一列 attempts=4 的 needs_attention，才能真的驗證「歸零」這個字。
    database
      .prepare(
        `INSERT INTO outbox_messages
           (message_id, owner_id, cause, chat_id, target_message_id, text, reply_markup,
            status, attempts, next_attempt_at, created_at, last_error)
         VALUES ('stuck', 'owner-1', 'transaction_confirmed', '55', '77', '已入帳', NULL,
                 'needs_attention', 4, ?, ?, 'Forbidden')`,
      )
      .run(NOW, NOW);

    await expect(repository.retryOutboxNeedsAttention("owner-1", LATER)).resolves.toBe(1);

    const row = database
      .prepare(
        "SELECT status, attempts, next_attempt_at FROM outbox_messages WHERE message_id = 'stuck'",
      )
      .get();
    expect(row).toEqual({ status: "pending", attempts: 0, next_attempt_at: LATER });
  });
});
