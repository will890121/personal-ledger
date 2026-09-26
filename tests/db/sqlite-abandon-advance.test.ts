import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { abandonAdvance } from "../../src/application/abandon-advance.js";
import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { SqliteLedgerRepository } from "../../src/db/sqlite-ledger-repository.js";

// 這個測試刻意避開 FakeLedgerRepository：放棄回收會先刪除代墊交易的全部配置再重建，
// 而 migration 0005 的 allocations.recovers_allocation_id 是指向 allocations 的外鍵，
// 只有真實 SQLite（開啟 foreign_keys）才會檢查這個接縫。
interface AbandonScenario {
  readonly repository: SqliteLedgerRepository;
  readonly database: ReturnType<typeof openDatabase>;
  readonly transactionId: string;
}

// 建立「代墊 500 + 個人支出 130，合計 630」的交易，再確認一筆 300 的回收。
async function setupPartiallyRecoveredAdvance(): Promise<AbandonScenario> {
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
    rawText: "代墊 500 自己 130",
    receivedAt: "2026-09-10T01:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "advance-draft",
    ownerId: "owner-1",
    requestId: "advance-request",
    sourceEventId: "advance-event",
    occurredDate: "2026-09-10",
    amount: { amount: "630", currency: "TWD" },
    allocations: [
      {
        allocationId: "advance-allocation",
        fundsEffect: "outflow",
        purpose: "advance",
        amount: { amount: "500", currency: "TWD" },
        category: "代墊",
        counterpartyId: "counterparty-1",
      },
      {
        allocationId: "own-expense-allocation",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount: "130", currency: "TWD" },
        category: "餐飲",
      },
    ],
    status: "awaiting_confirmation",
  });
  const advance = await repository.confirmDraft(
    "advance-draft",
    "2026-09-10T01:01:00.000Z",
    "advance-audit",
  );

  await repository.recordInputEvent({
    eventId: "recovery-event",
    ownerId: "owner-1",
    telegramUpdateId: "recovery-update",
    sourceType: "telegram",
    sourceRef: "recovery-message",
    rawText: "代墊回收 300",
    receivedAt: "2026-09-15T01:00:00.000Z",
  });
  await repository.saveDraft({
    draftId: "recovery-draft",
    ownerId: "owner-1",
    requestId: "recovery-request",
    sourceEventId: "recovery-event",
    occurredDate: "2026-09-15",
    amount: { amount: "300", currency: "TWD" },
    allocations: [
      {
        allocationId: "recovery-allocation",
        fundsEffect: "inflow",
        purpose: "advance_recovery",
        amount: { amount: "300", currency: "TWD" },
        category: "代墊回收",
        counterpartyId: "counterparty-1",
        recoversAllocationId: "advance-allocation",
      },
    ],
    status: "awaiting_confirmation",
  });
  await repository.confirmDraft("recovery-draft", "2026-09-15T01:01:00.000Z", "recovery-audit");

  return { repository, database, transactionId: advance.transactionId };
}

describe("abandonAdvance on a real sqlite repository", () => {
  it("splits the remaining advance without breaking the recovery foreign key", async () => {
    const { repository, database, transactionId } = await setupPartiallyRecoveredAdvance();
    let counter = 0;

    const result = await abandonAdvance(
      {
        ownerId: "owner-1",
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
    );

    expect(result.kind).toBe("abandoned");
    if (result.kind !== "abandoned") return;
    expect(result.amount).toBe("200");

    // 從資料庫重新載入，確認寫入結果而不是只看回傳值。
    const stored = await repository.getTransaction("owner-1", transactionId);
    expect(stored).not.toBeNull();
    if (!stored) return;

    // 代墊(已回收 300) + 原個人支出 130 + 放棄的支出 200。
    const advances = stored.allocations.filter((item) => item.purpose === "advance");
    expect(advances).toHaveLength(1);
    expect(advances[0]?.amount.amount).toBe("300");
    expect(
      stored.allocations
        .filter((item) => item.purpose === "expense")
        .map((item) => item.amount.amount)
        .sort(),
    ).toEqual(["130", "200"]);

    // 專案禁止原生浮點數運算，配置金額合計改以 Decimal 精確比較。
    const total = stored.allocations.reduce(
      (sum, item) => sum.plus(item.amount.amount),
      new Decimal(0),
    );
    expect(total.equals(new Decimal(stored.amount.amount))).toBe(true);

    // 回收配置仍指向原代墊配置，整體外鍵完整性未被破壞。
    expect(await repository.listRecoveryRows("owner-1")).toEqual([
      { recoversAllocationId: "advance-allocation", amount: "300" },
    ]);
    expect(database.pragma("foreign_key_check")).toEqual([]);

    // 放棄的支出歸屬原交易日期，不是操作當天。
    expect(stored.occurredDate).toBe("2026-09-10");
  });
});
