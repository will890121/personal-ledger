import { describe, expect, it, vi, type Mock } from "vitest";

import {
  ALLOCATIONS_HEADER,
  MONTHLY_SUMMARY_HEADER,
  TRANSACTIONS_HEADER,
} from "../../src/domain/sheet-rows.js";
import type {
  MirrorTransaction,
  SheetSyncRepository,
  SheetSyncState,
} from "../../src/ports/sheet-sync-repository.js";
import type { SummaryRepository } from "../../src/ports/summary-repository.js";
import { createSheetMirror, type SheetMirrorDependencies } from "../../src/sheets/sheet-mirror.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

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

function harness(options: { onNeedsAttention?: SheetMirrorDependencies["onNeedsAttention"] }): {
  mirror: ReturnType<typeof createSheetMirror>;
  sheets: FakeSheetsClient;
  advance: (ms: number) => void;
  getState: () => SheetSyncState;
} {
  let currentMs = INITIAL_NOW;
  const advance = (ms: number): void => {
    currentMs += ms;
  };

  let state: SheetSyncState = {
    ownerId: OWNER,
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastReconciledAt: null,
  };

  const syncRepository: SheetSyncRepository = {
    loadSyncState: () => Promise.resolve(state),
    saveSyncState: (next) => {
      state = next;
      return Promise.resolve();
    },
    // 每一輪都回同一筆交易：測試只在意失敗計數/升級行為，不在意實際搬了多少資料。
    listChangedTransactions: () => Promise.resolve([transaction()]),
  };

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
    now: () => new Date(currentMs),
    // exactOptionalPropertyTypes：只有真的有值才放這個鍵，避免顯式傳入 undefined。
    ...(options.onNeedsAttention === undefined
      ? {}
      : { onNeedsAttention: options.onNeedsAttention }),
  });

  return { mirror, sheets, advance, getState: () => state };
}

/** 讓下一輪的讀取失敗。用一個帶狀態碼的物件模擬 googleapis 的錯誤形狀。 */
function nextCallFailsWith(sheets: FakeSheetsClient, code: number): void {
  sheets.failNextWith = Object.assign(new Error("boom"), { code });
}

describe("sheet mirror failure escalation", () => {
  it("stays quiet through four consecutive failures", async () => {
    const onNeedsAttention = vi.fn();
    const { mirror, sheets, getState } = harness({ onNeedsAttention });

    for (let i = 0; i < 4; i += 1) {
      nextCallFailsWith(sheets, 500);
      const outcome = await mirror.syncOnce();
      expect(outcome.kind).toBe("failed");
    }

    expect(getState().consecutiveFailures).toBe(4);
    expect(onNeedsAttention).not.toHaveBeenCalled();
  });

  it("notifies on the fifth consecutive failure", async () => {
    const onNeedsAttention = vi.fn();
    const { mirror, sheets, getState } = harness({ onNeedsAttention });

    for (let i = 0; i < 5; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }

    expect(getState().consecutiveFailures).toBe(5);
    expect(onNeedsAttention).toHaveBeenCalledOnce();
    const [notified] = onNeedsAttention.mock.calls[0] as [SheetSyncState];
    expect(notified.consecutiveFailures).toBe(5);
  });

  it("resets the failure count after a success", async () => {
    // 變異：把 sheet-mirror.ts 成功分支的 consecutiveFailures = 0 拿掉，
    // 這個測試要變紅。
    const { mirror, sheets, getState } = harness({});

    for (let i = 0; i < 4; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }
    expect(getState().consecutiveFailures).toBe(4);

    const outcome = await mirror.syncOnce();

    expect(outcome.kind).toBe("synced");
    expect(getState().consecutiveFailures).toBe(0);
  });

  it("does not notify at the fifth failure when a success reset the counter", async () => {
    // 中間成功一次會把計數歸零，因此不會在第 5 次「累計」時誤觸——這裡的第 5 次
    // 失敗是整體第 5 次，但重置後只是連續第 1 次。
    const onNeedsAttention = vi.fn();
    const { mirror, sheets } = harness({ onNeedsAttention });

    for (let i = 0; i < 4; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }

    // 第 5 次呼叫：成功，把計數歸零。
    await mirror.syncOnce();

    // 這是整體第 6 次呼叫、但重置後的第 1 次連續失敗。
    nextCallFailsWith(sheets, 500);
    await mirror.syncOnce();

    expect(onNeedsAttention).not.toHaveBeenCalled();
  });

  it("does not let a throwing onNeedsAttention make syncOnce throw", async () => {
    const onNeedsAttention = vi.fn().mockRejectedValue(new Error("telegram is down"));
    const { mirror, sheets } = harness({ onNeedsAttention });

    for (let i = 0; i < 4; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }

    nextCallFailsWith(sheets, 500);
    const outcome = await mirror.syncOnce();

    expect(outcome.kind).toBe("failed");
    expect(onNeedsAttention).toHaveBeenCalledOnce();
  });

  it("stores only the classification and status code, never the raw error message", async () => {
    const { mirror, sheets, getState } = harness({});
    sheets.failNextWith = new Error("Spreadsheet abc123SECRET was not found");

    await mirror.syncOnce();

    expect(getState().lastError).not.toContain("abc123SECRET");
    expect(getState().lastError).not.toContain("Spreadsheet");
  });

  it("classifies a 404 (deleted spreadsheet) as permanent in the stored error", async () => {
    const { mirror, sheets, getState } = harness({});
    nextCallFailsWith(sheets, 404);

    await mirror.syncOnce();

    expect(getState().lastError).toBe("permanent:404");
  });

  it("classifies a 503 (transient) in the stored error", async () => {
    const { mirror, sheets, getState } = harness({});
    nextCallFailsWith(sheets, 503);

    await mirror.syncOnce();

    expect(getState().lastError).toBe("transient:503");
  });
});

describe("sheet mirror needs-attention throttle", () => {
  it("does not notify again within ten minutes of a successful notification", async () => {
    const onNeedsAttention = vi.fn().mockResolvedValue(undefined);
    const { mirror, sheets, advance } = harness({ onNeedsAttention });

    for (let i = 0; i < 5; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }
    expect(onNeedsAttention).toHaveBeenCalledOnce();

    advance(9 * 60_000);
    nextCallFailsWith(sheets, 500);
    await mirror.syncOnce();

    expect(onNeedsAttention).toHaveBeenCalledOnce();
  });

  it("notifies again once the throttle window has passed", async () => {
    const onNeedsAttention = vi.fn().mockResolvedValue(undefined);
    const { mirror, sheets, advance } = harness({ onNeedsAttention });

    for (let i = 0; i < 5; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }
    expect(onNeedsAttention).toHaveBeenCalledOnce();

    advance(11 * 60_000);
    nextCallFailsWith(sheets, 500);
    await mirror.syncOnce();

    expect(onNeedsAttention).toHaveBeenCalledTimes(2);
  });

  it("does not let a failed notification consume the throttle window", async () => {
    // 節流時間戳只在送出成功時才寫入——送失敗代表使用者根本沒收到，不該因此
    // 買到接下來十分鐘的靜默。
    const onNeedsAttention: Mock<NonNullable<SheetMirrorDependencies["onNeedsAttention"]>> =
      vi.fn<NonNullable<SheetMirrorDependencies["onNeedsAttention"]>>();
    onNeedsAttention.mockRejectedValueOnce(new Error("telegram is down"));
    onNeedsAttention.mockResolvedValue(undefined);
    const { mirror, sheets, advance } = harness({ onNeedsAttention });

    for (let i = 0; i < 5; i += 1) {
      nextCallFailsWith(sheets, 500);
      await mirror.syncOnce();
    }
    expect(onNeedsAttention).toHaveBeenCalledOnce();

    // 只過一分鐘——若第一次「失敗的」通知消耗了節流窗口，這裡就會被吃掉而不重試。
    advance(60_000);
    nextCallFailsWith(sheets, 500);
    await mirror.syncOnce();

    expect(onNeedsAttention).toHaveBeenCalledTimes(2);
  });
});
