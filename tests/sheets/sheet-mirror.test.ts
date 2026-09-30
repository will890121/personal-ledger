import { describe, expect, it, vi } from "vitest";

import { toSheetSerialDate } from "../../src/domain/sheet-serial-date.js";
import type {
  MirrorTransaction,
  SheetSyncRepository,
  SheetSyncState,
} from "../../src/ports/sheet-sync-repository.js";
import type { SummaryRepository } from "../../src/ports/summary-repository.js";
import { createSheetMirror } from "../../src/sheets/sheet-mirror.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

const OWNER = "owner-1";
const NOW = new Date("2026-10-01T05:00:00.000Z");

function transaction(overrides: Partial<MirrorTransaction> = {}): MirrorTransaction {
  return {
    transactionId: "t1",
    occurredDate: "2026-10-05",
    occurredTime: null,
    amount: "100",
    accountFromName: null,
    accountToName: null,
    merchantName: null,
    counterpartyName: null,
    note: null,
    rawInputSnapshot: null,
    status: "confirmed",
    confirmedAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    allocations: [],
    ...overrides,
  };
}

const ZERO_SUMMARY = {
  actualInflow: { amount: "0", currency: "TWD" as const },
  actualOutflow: { amount: "0", currency: "TWD" as const },
  netCashFlow: { amount: "0", currency: "TWD" as const },
  personalIncome: { amount: "0", currency: "TWD" as const },
  grossPersonalExpense: { amount: "0", currency: "TWD" as const },
  refunds: { amount: "0", currency: "TWD" as const },
  netPersonalExpense: { amount: "0", currency: "TWD" as const },
  personalBalance: { amount: "0", currency: "TWD" as const },
  categories: [],
};

function harness(options: {
  changed: MirrorTransaction[];
  sheet?: Record<string, string[][]>;
  state?: Partial<SheetSyncState>;
}) {
  const saved: SheetSyncState[] = [];
  const state: SheetSyncState = {
    ownerId: OWNER,
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastReconciledAt: null,
    ...options.state,
  };
  const syncRepository: SheetSyncRepository = {
    loadSyncState: () => Promise.resolve(state),
    saveSyncState: (next) => {
      saved.push(next);
      return Promise.resolve();
    },
    listChangedTransactions: () => Promise.resolve(options.changed),
  };
  const summarize = vi.fn(() => Promise.resolve(ZERO_SUMMARY));
  const summaryRepository = { summarize } as unknown as SummaryRepository;
  const sheets = new FakeSheetsClient(
    options.sheet ?? {
      Transactions: [["transaction_id", "日期"]],
      Allocations: [["allocation_id"]],
      MonthlySummary: [["月份"]],
    },
  );
  const mirror = createSheetMirror({
    ownerId: OWNER,
    sheets,
    syncRepository,
    summaryRepository,
    now: () => NOW,
  });
  return { mirror, sheets, saved, summarize };
}

describe("sheet mirror", () => {
  it("appends a new transaction after the last row", async () => {
    // 新 id 沒有既有列號，必須附加到最後而不是覆蓋標題或任何既有資料。
    const { mirror, sheets } = harness({ changed: [transaction()] });

    await mirror.syncOnce();

    const rows = sheets.snapshot("Transactions");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe("t1");
  });

  it("updates in place instead of adding a second row for the same id", async () => {
    // 這就是 upsert 的意義。若每次都附加，Sheet 會隨同步次數不斷長出重複列——
    // 而 AC-22 明確要求「無重複列」。
    const { mirror, sheets } = harness({
      changed: [transaction({ amount: "999" })],
      sheet: {
        Transactions: [
          ["transaction_id", "日期"],
          ["t1", String(toSheetSerialDate("2026-10-05"))],
        ],
        Allocations: [["allocation_id"]],
        MonthlySummary: [["月份"]],
      },
    });

    await mirror.syncOnce();

    const rows = sheets.snapshot("Transactions");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[3]).toBe("999");
  });

  it("re-locates a row the user moved instead of writing to the old position", async () => {
    // Review Focus #3。使用者在資料最上方手動插入一列，t1 從第 2 列移到第 3 列。
    // 若列號來自快取或假設，更新會落在第 2 列，把使用者插入的那一列蓋掉——
    // 而且沒有任何東西會報錯，使用者只會看到資料莫名其妙變了。
    const { mirror, sheets } = harness({
      changed: [transaction({ amount: "777" })],
      sheet: {
        Transactions: [
          ["transaction_id", "日期"],
          ["使用者自己插入的一列", ""],
          ["t1", String(toSheetSerialDate("2026-10-05"))],
        ],
        Allocations: [["allocation_id"]],
        MonthlySummary: [["月份"]],
      },
    });

    await mirror.syncOnce();

    const rows = sheets.snapshot("Transactions");
    expect(rows[1]?.[0]).toBe("使用者自己插入的一列");
    expect(rows[2]?.[0]).toBe("t1");
    expect(rows[2]?.[3]).toBe("777");
  });

  it("does not advance the cursor when the write fails", async () => {
    // 失敗就整輪不推進，下一輪三張分頁全部重做（冪等）。
    // 若失敗仍推進游標，那批變更會被永久跳過，而且沒有任何東西會發現。
    const { mirror, sheets, saved } = harness({ changed: [transaction()] });
    sheets.failNextWith = new Error("boom");

    const outcome = await mirror.syncOnce();

    expect(outcome.kind).toBe("failed");
    expect(saved.filter((state) => state.cursorTransactionId === "t1")).toHaveLength(0);
  });

  it("recomputes both months when a transaction moves across a month boundary", async () => {
    // Review Focus #1 在引擎層的對應測試。Sheet 上 t1 的舊日期是 9/28，
    // 新資料是 10/05。若只用新日期，9 月的摘要會靜默停在錯的數字。
    const { mirror, summarize } = harness({
      changed: [transaction({ occurredDate: "2026-10-05" })],
      sheet: {
        Transactions: [
          ["transaction_id", "日期"],
          ["t1", String(toSheetSerialDate("2026-09-28"))],
        ],
        Allocations: [["allocation_id"]],
        MonthlySummary: [["月份"]],
      },
    });

    await mirror.syncOnce();

    const ranges = summarize.mock.calls.map(
      (call) => (call as unknown as [string, { from: string }])[1].from,
    );
    expect(ranges).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("makes no sheets call when nothing changed", async () => {
    // 配額設計的基礎（spec §7）。Task 9 的執行器也有一條同名的測試，
    // 但擋在這一層才是真的——執行器只是不呼叫它而已。
    const { mirror, sheets } = harness({ changed: [] });

    const outcome = await mirror.syncOnce();

    expect(outcome.kind).toBe("idle");
    expect(sheets.callCount).toBe(0);
  });

  it("reconcile records last_reconciled_at and never rewinds the cursor", async () => {
    // 校正是全表重掃（cursor 傳 null），所以這一批的最後一筆很可能比目前的游標舊。
    // 若照抄它當新游標，游標會倒退，之後每一輪都重做同一段——而且只會愈積愈多。
    const { mirror, saved } = harness({
      changed: [transaction()],
      state: {
        cursorUpdatedAt: "2026-12-31T00:00:00.000Z",
        cursorTransactionId: "t9",
      },
    });

    const outcome = await mirror.reconcile();

    expect(outcome.kind).toBe("synced");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.lastReconciledAt).toBe(NOW.toISOString());
    expect(saved[0]?.cursorUpdatedAt).toBe("2026-12-31T00:00:00.000Z");
    expect(saved[0]?.cursorTransactionId).toBe("t9");
  });
});
