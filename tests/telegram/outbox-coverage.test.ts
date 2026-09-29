import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { abandonAdvance } from "../../src/application/abandon-advance.js";
import {
  softDeleteConfirmedTransaction,
  updateConfirmedTransaction,
} from "../../src/application/mutate-transaction.js";
import { recordRecovery } from "../../src/application/record-recovery.js";
import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";
import type { ConfirmedTransaction } from "../../src/domain/ledger.js";
import {
  OutboxCauseSchema,
  type OutboxCause,
  type OutboxMessage,
} from "../../src/domain/outbox.js";
import type { OutboxRequest } from "../../src/ports/ledger-repository.js";

const OWNER_ID = "owner-1";

// 測試不關心遞送內容，只需要滿足各個 repository/application 方法的必填 outbox 參數。
function testOutbox(messageId: string, cause: OutboxCause): OutboxRequest<ConfirmedTransaction> {
  return { messageId, cause, render: () => ({ chatId: "1", text: "ok" }) };
}

function freshRepository(): { database: Database.Database; repository: SqliteLedgerRepository } {
  const database = openDatabase(":memory:");
  migrate(database);
  return { database, repository: new SqliteLedgerRepository(database) };
}

/**
 * 讀出一個 repository 目前所有還算數的 outbox 列（不分狀態）。故意繞過
 * `claimDueOutbox` 原本「取得遞送 lease」的用途——這裡只是借用它公開、真實
 * 存在的查詢邏輯來驗證列數與 cause，租期訂在遙遠的未來，讓每個情境自己建立
 * 的少數幾筆訊息必定「已到期」而被撈到。
 */
async function allOutbox(repository: SqliteLedgerRepository): Promise<readonly OutboxMessage[]> {
  return repository.claimDueOutbox(
    OWNER_ID,
    "2999-01-01T00:00:00.000Z",
    "2999-01-01T00:05:00.000Z",
    100,
  );
}

// 建一筆已確認的一般支出交易，並立刻把 seed 過程自己產生的那一列 outbox 標成
// delivered——每個情境要驗證的是「後續那個動作恰好多出一列」，不是 seed 本身。
async function seedConfirmedExpense(
  repository: SqliteLedgerRepository,
): Promise<ConfirmedTransaction> {
  await repository.recordInputEvent({
    eventId: "seed-event",
    ownerId: OWNER_ID,
    telegramUpdateId: "seed-update",
    sourceType: "telegram",
    sourceRef: "seed-message",
    rawText: "午餐 120",
    receivedAt: "2026-09-30T01:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "seed-draft",
    ownerId: OWNER_ID,
    requestId: "seed-request",
    sourceEventId: "seed-event",
    occurredDate: "2026-09-30",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: "seed-allocation",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount: "120", currency: "TWD" },
        category: "餐飲",
      },
    ],
    status: "awaiting_confirmation",
  });
  const confirmed = await repository.confirmDraft(
    "seed-draft",
    "2026-09-30T01:01:00.000Z",
    "seed-audit",
    testOutbox("outbox-seed", "transaction_confirmed"),
  );
  await repository.markOutboxDelivered("outbox-seed", "2026-09-30T01:01:00.000Z");
  return confirmed;
}

// 建一筆已確認的代墊交易，同樣先把 seed 產生的 outbox 列標成 delivered。
// 代墊配置的 counterparty_id 是外鍵，必須先有一列 counterparties。
async function seedConfirmedAdvance(
  database: Database.Database,
  repository: SqliteLedgerRepository,
  amount: string,
): Promise<ConfirmedTransaction> {
  database
    .prepare(
      "INSERT INTO counterparties (counterparty_id, owner_id, name, normalized_name) VALUES (?, ?, ?, ?)",
    )
    .run("counterparty-1", OWNER_ID, "朋友", "朋友");
  await repository.recordInputEvent({
    eventId: "advance-event",
    ownerId: OWNER_ID,
    telegramUpdateId: "advance-update",
    sourceType: "telegram",
    sourceRef: "advance-message",
    rawText: `代墊 ${amount}`,
    receivedAt: "2026-09-10T01:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "advance-draft",
    ownerId: OWNER_ID,
    requestId: "advance-request",
    sourceEventId: "advance-event",
    occurredDate: "2026-09-10",
    amount: { amount, currency: "TWD" },
    allocations: [
      {
        allocationId: "advance-allocation",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount, currency: "TWD" },
        category: "代墊",
        counterpartyId: "counterparty-1",
      },
    ],
    status: "awaiting_confirmation",
  });
  const advance = await repository.confirmDraft(
    "advance-draft",
    "2026-09-10T01:01:00.000Z",
    "advance-audit",
    testOutbox("outbox-advance-seed", "transaction_confirmed"),
  );
  await repository.markOutboxDelivered("outbox-advance-seed", "2026-09-10T01:01:00.000Z");
  return advance;
}

async function confirmScenario(): Promise<{ repository: SqliteLedgerRepository }> {
  const { repository } = freshRepository();
  await repository.recordInputEvent({
    eventId: "event-1",
    ownerId: OWNER_ID,
    telegramUpdateId: "update-1",
    sourceType: "telegram",
    sourceRef: "message-1",
    rawText: "午餐 120",
    receivedAt: "2026-09-30T01:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "draft-confirm",
    ownerId: OWNER_ID,
    requestId: "request-confirm",
    sourceEventId: "event-1",
    occurredDate: "2026-09-30",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: "allocation-confirm",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount: "120", currency: "TWD" },
        category: "餐飲",
      },
    ],
    status: "awaiting_confirmation",
  });
  await repository.confirmDraft(
    "draft-confirm",
    "2026-09-30T01:01:00.000Z",
    "audit-confirm",
    testOutbox("outbox-confirm", "transaction_confirmed"),
  );
  return { repository };
}

async function recoveryScenario(): Promise<{ repository: SqliteLedgerRepository }> {
  const { database, repository } = freshRepository();
  await seedConfirmedAdvance(database, repository, "300");

  let counter = 0;
  const result = await recordRecovery(
    {
      ownerId: OWNER_ID,
      counterpartyId: "counterparty-1",
      received: "300",
      occurredDate: "2026-09-15",
      telegramUpdateId: "recovery-update",
      sourceRef: "recovery-message",
      rawText: "朋友還 300",
      receivedAt: "2026-09-15T01:00:00.000Z",
    },
    { repository, generateId: () => `recovery-${String(++counter)}`, incomeCategoryIds: [] },
  );
  if (result.kind !== "draft") {
    throw new Error(`expected a fully-matched recovery draft, got "${result.kind}"`);
  }

  // 與 drafts.ts 的 confirm: handler 同一套邏輯：回收草稿（配置全是
  // advance_recovery）走的還是 confirmDraft，差別只在 cause 選
  // recovery_recorded 而非 transaction_confirmed。
  await repository.confirmDraft(
    result.draft.draftId,
    "2026-09-15T01:02:00.000Z",
    "recovery-audit",
    testOutbox("outbox-recovery", "recovery_recorded"),
  );
  return { repository };
}

async function abandonScenario(): Promise<{ repository: SqliteLedgerRepository }> {
  const { database, repository } = freshRepository();
  await seedConfirmedAdvance(database, repository, "630");

  let counter = 0;
  const result = await abandonAdvance(
    {
      ownerId: OWNER_ID,
      allocationId: "advance-allocation",
      telegramUpdateId: "abandon-update",
      sourceRef: "abandon-message",
      receivedAt: "2026-09-24T01:00:00.000Z",
    },
    {
      repository,
      generateId: () => `abandon-${String(++counter)}`,
      now: () => new Date("2026-09-24T01:00:00.000Z"),
    },
    testOutbox("outbox-abandon", "advance_abandoned"),
  );
  if (result.kind !== "abandoned") {
    throw new Error(`expected the abandonment to succeed, got "${result.kind}"`);
  }
  return { repository };
}

async function updateScenario(): Promise<{ repository: SqliteLedgerRepository }> {
  const { repository } = freshRepository();
  const confirmed = await seedConfirmedExpense(repository);
  const eventId = "update-event";
  await updateConfirmedTransaction(
    {
      ownerId: OWNER_ID,
      transactionId: confirmed.transactionId,
      sourceEventId: eventId,
      auditEventId: "audit-update",
      expectedUpdatedAt: confirmed.updatedAt ?? confirmed.confirmedAt,
      replacement: { ...confirmed, note: "改成晚餐" },
      changedAt: "2026-09-30T02:00:00.000Z",
    },
    {
      repository,
      inputEvent: {
        eventId,
        ownerId: OWNER_ID,
        telegramUpdateId: "update-update",
        sourceType: "telegram",
        sourceRef: "update-message",
        rawText: "改成晚餐",
        receivedAt: "2026-09-30T02:00:00.000Z",
      },
    },
    testOutbox("outbox-update", "transaction_updated"),
  );
  return { repository };
}

async function deleteScenario(): Promise<{ repository: SqliteLedgerRepository }> {
  const { repository } = freshRepository();
  const confirmed = await seedConfirmedExpense(repository);
  const eventId = "delete-event";
  await softDeleteConfirmedTransaction(
    {
      ownerId: OWNER_ID,
      transactionId: confirmed.transactionId,
      sourceEventId: eventId,
      auditEventId: "audit-delete",
      expectedUpdatedAt: confirmed.updatedAt ?? confirmed.confirmedAt,
      changedAt: "2026-09-30T03:00:00.000Z",
    },
    {
      repository,
      inputEvent: {
        eventId,
        ownerId: OWNER_ID,
        telegramUpdateId: "delete-update",
        sourceType: "telegram",
        sourceRef: "delete-message",
        rawText: "刪除交易",
        receivedAt: "2026-09-30T03:00:00.000Z",
      },
    },
    testOutbox("outbox-delete", "transaction_deleted"),
  );
  return { repository };
}

describe("every ledger change queues a message", () => {
  // 規則要單純到好記：帳本一旦變了，使用者就一定會收到訊息。只保證其中幾種，
  // 日後沒有人記得哪些有保證。
  it.each([
    ["transaction_confirmed", confirmScenario],
    ["recovery_recorded", recoveryScenario],
    ["advance_abandoned", abandonScenario],
    ["transaction_updated", updateScenario],
    ["transaction_deleted", deleteScenario],
  ] as const)("queues one message for %s", async (cause, scenario) => {
    const { repository } = await scenario();

    const rows = await allOutbox(repository);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cause).toBe(cause);
  });

  it("covers every cause the schema allows", () => {
    // 新增 cause 卻忘記接上產生者時，這條會紅。
    expect(new Set(OutboxCauseSchema.options)).toEqual(
      new Set([
        "transaction_confirmed",
        "recovery_recorded",
        "advance_abandoned",
        "transaction_updated",
        "transaction_deleted",
      ]),
    );
  });
});
