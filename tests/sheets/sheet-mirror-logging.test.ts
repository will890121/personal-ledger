import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOCATIONS_HEADER,
  MONTHLY_SUMMARY_HEADER,
  TRANSACTIONS_HEADER,
} from "../../src/domain/sheet-rows.js";
import { toSheetSerialDate } from "../../src/domain/sheet-serial-date.js";
import { logger } from "../../src/logger.js";
import type {
  MirrorTransaction,
  SheetSyncRepository,
  SheetSyncState,
} from "../../src/ports/sheet-sync-repository.js";
import type { SummaryRepository } from "../../src/ports/summary-repository.js";
import { createSheetMirror, type SheetMirrorDependencies } from "../../src/sheets/sheet-mirror.js";
import { ESCALATE_AFTER_FAILURES } from "../../src/sheets/sheet-failure.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

// 收掉 docs/todo/outbox-delivery-logging.md：這份 todo 的完成標準是「拔掉任何一行
// 新增的日誌，都要有測試變紅」——本檔案逐行釘住 Sheets 鏡像這條管線新增的四個事件。

const OWNER = "owner-1";
const INITIAL_NOW = Date.parse("2026-10-01T05:00:00.000Z");

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

/** 沿用 sheet-mirror-failure.test.ts 的假倉儲：state 存在外部變數，模擬 settings 表。 */
function createFakeSyncRepository(initialState: Partial<SheetSyncState> = {}): {
  syncRepository: SheetSyncRepository;
  getState: () => SheetSyncState;
} {
  let state: SheetSyncState = {
    ownerId: OWNER,
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastReconciledAt: null,
    ...initialState,
  };

  const syncRepository: SheetSyncRepository = {
    loadSyncState: () => Promise.resolve(state),
    saveSyncState: (next) => {
      state = next;
      return Promise.resolve();
    },
    listChangedTransactions: () => Promise.resolve([transaction()]),
    loadAlertAt: () => Promise.resolve(null),
    saveAlertAt: () => Promise.resolve(),
  };

  return { syncRepository, getState: () => state };
}

function harness(options: {
  onNeedsAttention?: SheetMirrorDependencies["onNeedsAttention"];
  initialState?: Partial<SheetSyncState>;
}): {
  mirror: ReturnType<typeof createSheetMirror>;
  sheets: FakeSheetsClient;
  getState: () => SheetSyncState;
} {
  const { syncRepository, getState } = createFakeSyncRepository(options.initialState);

  const summaryRepository = {
    summarize: () => Promise.resolve(ZERO_SUMMARY),
  } as unknown as SummaryRepository;

  const sheets = new FakeSheetsClient({
    Transactions: [[...TRANSACTIONS_HEADER]],
    Allocations: [[...ALLOCATIONS_HEADER]],
    MonthlySummary: [[...MONTHLY_SUMMARY_HEADER]],
  });

  const mirror = createSheetMirror({
    ownerId: OWNER,
    sheets,
    syncRepository,
    summaryRepository,
    now: () => new Date(INITIAL_NOW),
    ...(options.onNeedsAttention === undefined
      ? {}
      : { onNeedsAttention: options.onNeedsAttention }),
  });

  return { mirror, sheets, getState };
}

function nextCallFailsWith(sheets: FakeSheetsClient, code: number): void {
  sheets.failNextWith = Object.assign(new Error("boom"), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sheet mirror logging", () => {
  it("logs an info line when a sync fails and will retry", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { mirror, sheets } = harness({});
    nextCallFailsWith(sheets, 503);

    await mirror.syncOnce();

    expect(infoSpy).toHaveBeenCalledWith(
      "sheet mirror sync failed; will retry",
      expect.objectContaining({ mode: "incremental", consecutiveFailures: 1 }),
    );
  });

  it("logs a warn line when consecutive failures reach the escalation threshold", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { mirror, sheets } = harness({});

    for (let i = 0; i < ESCALATE_AFTER_FAILURES; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }

    expect(warnSpy).toHaveBeenCalledWith(
      "sheet mirror consecutive failures escalated",
      expect.objectContaining({ consecutiveFailures: ESCALATE_AFTER_FAILURES }),
    );
  });

  it("does not log the escalation warning before the threshold is reached", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { mirror, sheets } = harness({});

    for (let i = 0; i < ESCALATE_AFTER_FAILURES - 1; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }

    expect(warnSpy).not.toHaveBeenCalledWith(
      "sheet mirror consecutive failures escalated",
      expect.anything(),
    );
  });

  it("logs an info line when a sync recovers after previous failures", async () => {
    const { mirror, sheets } = harness({});

    for (let i = 0; i < 3; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }

    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await mirror.syncOnce();

    expect(infoSpy).toHaveBeenCalledWith(
      "sheet mirror recovered from failure",
      expect.objectContaining({ mode: "incremental", previousConsecutiveFailures: 3 }),
    );
  });

  it("does not log a recovery line on an ordinary success with no prior failures", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { mirror } = harness({});

    await mirror.syncOnce();

    expect(infoSpy).not.toHaveBeenCalledWith(
      "sheet mirror recovered from failure",
      expect.anything(),
    );
  });

  describe("reconcile truncated by the page cap", () => {
    const FULL_PAGE: MirrorTransaction[] = Array.from({ length: 200 }, (_, i) =>
      transaction({
        transactionId: `page-txn-${String(i)}`,
        updatedAt: `2026-10-05T00:00:00.${String(i).padStart(3, "0")}Z`,
      }),
    );

    const EXISTING_ROW = (id: string, amount: string): string[] => [
      id,
      String(toSheetSerialDate("2026-01-01")),
      "",
      amount,
      "",
      "",
      "",
      "",
      "",
      "",
      "confirmed",
      "",
      "2026-01-01T00:00:00.000Z",
    ];

    function truncatedHarness(): { mirror: ReturnType<typeof createSheetMirror> } {
      const { syncRepository } = createFakeSyncRepository({
        lastReconciledAt: "2026-09-01T00:00:00.000Z",
      });
      // 每一頁都回滿滿一批，永遠不會觸發「這批不滿」的自然終止——逼出截斷分支。
      syncRepository.listChangedTransactions = () => Promise.resolve(FULL_PAGE);

      const summaryRepository = {
        summarize: () => Promise.resolve(ZERO_SUMMARY),
      } as unknown as SummaryRepository;

      const sheets = new FakeSheetsClient({
        Transactions: [
          [...TRANSACTIONS_HEADER],
          EXISTING_ROW("00000000-0000-4000-8000-000000000001", "500"),
        ],
        Allocations: [[...ALLOCATIONS_HEADER]],
        MonthlySummary: [[...MONTHLY_SUMMARY_HEADER]],
      });

      const mirror = createSheetMirror({
        ownerId: OWNER,
        sheets,
        syncRepository,
        summaryRepository,
        now: () => new Date(INITIAL_NOW),
        reconcileMaxPages: 1, // 逼出截斷：只給一頁，掃不到全部既有列。
      });

      return { mirror };
    }

    it("logs a warn line when the page cap truncates a reconcile pass", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const { mirror } = truncatedHarness();

      const outcome = await mirror.reconcile();

      expect(outcome).toMatchObject({ kind: "synced", scannedToEnd: false });
      expect(warnSpy).toHaveBeenCalledWith(
        "sheet mirror reconcile truncated by page cap; some rows not verified",
        expect.objectContaining({ pages: 1 }),
      );
    });

    it("does not log the truncation warning for a reconcile that scans to the end", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const { syncRepository } = createFakeSyncRepository();
      const summaryRepository = {
        summarize: () => Promise.resolve(ZERO_SUMMARY),
      } as unknown as SummaryRepository;
      const sheets = new FakeSheetsClient({
        Transactions: [[...TRANSACTIONS_HEADER]],
        Allocations: [[...ALLOCATIONS_HEADER]],
        MonthlySummary: [[...MONTHLY_SUMMARY_HEADER]],
      });
      const mirror = createSheetMirror({
        ownerId: OWNER,
        sheets,
        syncRepository,
        summaryRepository,
        now: () => new Date(INITIAL_NOW),
      });

      const outcome = await mirror.reconcile();

      expect(outcome).toMatchObject({ kind: "synced", scannedToEnd: true });
      expect(warnSpy).not.toHaveBeenCalledWith(
        "sheet mirror reconcile truncated by page cap; some rows not verified",
        expect.anything(),
      );
    });
  });
});
