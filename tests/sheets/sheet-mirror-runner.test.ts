import { describe, expect, it, vi } from "vitest";

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
import {
  createSheetMirror,
  type SheetMirror,
  type SyncOutcome,
} from "../../src/sheets/sheet-mirror.js";
import {
  createSheetMirrorRunner,
  RECONCILE_HOUR,
  type SheetMirrorRunnerDependencies,
} from "../../src/sheets/sheet-mirror-runner.js";
import { FakeSheetsClient } from "../support/fake-sheets-client.js";

const OWNER = "owner-1";
const TZ = "Asia/Taipei";

function transaction(id: string): MirrorTransaction {
  return {
    transactionId: id,
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

/**
 * 真的引擎 + 真的（模擬）Sheets client：用來驗證「idle 一次 API 都不打」與
 * 「有變更就真的會打」這兩條互相成立的保證，見 brief 對這兩條測試的說明——
 * 少了對照組，第一條若因為同步整個壞掉也會通過。
 *
 * `nowIso` 刻意落在 RECONCILE_HOUR 之前（Taipei 00:10），確保這兩條測試
 * 走的是增量路徑，不會因為剛好撞上校正時刻而變得跟時區判斷耦合在一起。
 */
function apiHarness(options: { changed: MirrorTransaction[] }): {
  runner: ReturnType<typeof createSheetMirrorRunner>;
  sheets: FakeSheetsClient;
  logError: ReturnType<typeof vi.fn>;
} {
  const nowIso = "2026-10-01T16:10:00.000Z"; // Asia/Taipei 2026-10-02 00:10
  const state: SheetSyncState = {
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
      Object.assign(state, next);
      return Promise.resolve();
    },
    listChangedTransactions: () => Promise.resolve(options.changed),
    loadAlertAt: () => Promise.resolve(null),
    saveAlertAt: () => Promise.resolve(),
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
    now: () => new Date(nowIso),
  });
  const logError = vi.fn();
  const runner = createSheetMirrorRunner({
    mirror,
    syncRepository,
    ownerId: OWNER,
    timezone: TZ,
    now: () => new Date(nowIso),
    logError,
  });
  return { runner, sheets, logError };
}

/**
 * 假引擎（syncOnce／reconcile 都是各自獨立的 vi.fn()）：用來驗證「走哪一條路」
 * 與「失敗時的行為」，跟引擎內部實作無關，不需要真的建一個 FakeSheetsClient。
 */
function mirrorHarness(options: {
  lastReconciledAt: string | null;
  nowIso: string;
  syncOnceResult?: SyncOutcome | Promise<SyncOutcome>;
  reconcileResult?: SyncOutcome | Promise<SyncOutcome>;
}): {
  runner: ReturnType<typeof createSheetMirrorRunner>;
  mirror: { syncOnce: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn> };
  logError: ReturnType<typeof vi.fn>;
} {
  const idle: SyncOutcome = { kind: "idle" };
  const syncOnce = vi.fn().mockResolvedValue(options.syncOnceResult ?? idle);
  const reconcile = vi.fn().mockResolvedValue(options.reconcileResult ?? idle);
  const mirror = { syncOnce, reconcile } as unknown as SheetMirror;
  const state: SheetSyncState = {
    ownerId: OWNER,
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastReconciledAt: options.lastReconciledAt,
  };
  const syncRepository: Pick<SheetSyncRepository, "loadSyncState"> = {
    loadSyncState: () => Promise.resolve(state),
  };
  const logError = vi.fn();
  const deps: SheetMirrorRunnerDependencies = {
    mirror,
    syncRepository,
    ownerId: OWNER,
    timezone: TZ,
    now: () => new Date(options.nowIso),
    logError,
  };
  const runner = createSheetMirrorRunner(deps);
  return { runner, mirror: { syncOnce, reconcile }, logError };
}

describe("sheet mirror runner", () => {
  it("makes no api call when nothing changed", async () => {
    // 這是整個配額設計的基礎（spec §7）：Sheets API 每使用者每分鐘 60 次寫入，
    // 20 秒 tick 若無條件同步就會空轉逼近上限。這種「省略某件事」的保證特別容易
    // 只存在於註解裡——M4 就有一條宣稱在真實參數下並不成立。
    const { runner, sheets } = apiHarness({ changed: [] });

    await runner.syncNow();

    expect(sheets.callCount).toBe(0);
  });

  it("does call the api when something changed", async () => {
    // 上面那條若因為別的原因（例如同步整個壞掉）而通過，這條會抓到。
    const { runner, sheets } = apiHarness({ changed: [transaction("t1")] });

    await runner.syncNow();

    expect(sheets.callCount).toBeGreaterThan(0);
  });

  it("unrefs its timer so the process can exit", () => {
    // 沒有 unref 的話 LEDGER_STARTUP_CHECK 探針會掛住不退出——M4 踩過同一個坑。
    // 比照 tests/telegram/outbox-runner.test.ts 既有的 unref 測試：用真正的
    // setInterval/clearInterval（spy 攔截取得真正的 Timeout 控制代碼），
    // 不用 vi.useFakeTimers()，那套機制不模擬 ref/unref 的實際行為。
    const { runner } = apiHarness({ changed: [] });
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      runner.start();

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      const timerResult = setIntervalSpy.mock.results[0];
      if (!timerResult || timerResult.type !== "return") {
        throw new Error("setInterval did not return synchronously");
      }
      const timer = timerResult.value;
      expect(timer.hasRef()).toBe(false);

      runner.stop();

      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("swallows and logs a rejected background sync instead of killing the process", async () => {
    // M4 的 C1：void 一個會 reject 的 promise，Node 24 預設會終止行程，
    // 而 compose 是 restart: unless-stopped——每 20 秒一次的 crash loop。
    // 這裡從第一天就做對，不要重蹈。
    //
    // nowIso 落在 RECONCILE_HOUR 之前，確保走的是 syncOnce，讓失敗的路徑單純。
    const { runner, mirror, logError } = mirrorHarness({
      lastReconciledAt: null,
      nowIso: "2026-10-01T16:10:00.000Z", // Taipei 00:10
      syncOnceResult: Promise.reject(new Error("Sheets API is down")),
    });
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const unhandled: unknown[] = [];
    const collect = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", collect);

    try {
      runner.start();
      const tick = setIntervalSpy.mock.calls[0]?.[0];
      if (typeof tick !== "function") throw new Error("start() did not schedule a tick");
      tick();
      // unhandledRejection 是在 microtask queue 排空之後才發出的，要讓出一個
      // macrotask 才看得到它——否則這個斷言永遠不會失敗。
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(logError).toHaveBeenCalledOnce();
      expect(logError.mock.calls[0]?.[0]).toBe("sheet mirror sync failed");
      expect(mirror.syncOnce).toHaveBeenCalledOnce();
    } finally {
      runner.stop();
      process.removeListener("unhandledRejection", collect);
      setIntervalSpy.mockRestore();
    }
  });

  it("runs a full reconcile once a day at the configured hour", async () => {
    // lastReconciledAt 是昨天且現在是 04:xx（Taipei）→ 走 reconcile。
    const { runner, mirror } = mirrorHarness({
      lastReconciledAt: "2026-10-01T10:00:00.000Z", // Taipei 2026-10-01 18:00
      nowIso: "2026-10-01T20:10:00.000Z", // Taipei 2026-10-02 04:10
    });

    await runner.syncNow();

    expect(mirror.reconcile).toHaveBeenCalledOnce();
    expect(mirror.syncOnce).not.toHaveBeenCalled();
  });

  it("runs an incremental sync when today's reconcile has already happened", async () => {
    // 已經是今天校正過 → 走一般增量，不重複校正。
    const { runner, mirror } = mirrorHarness({
      lastReconciledAt: "2026-10-02T00:30:00.000Z", // Taipei 2026-10-02 08:30（今天已校正）
      nowIso: "2026-10-01T20:10:00.000Z", // Taipei 2026-10-02 04:10
    });

    await runner.syncNow();

    expect(mirror.syncOnce).toHaveBeenCalledOnce();
    expect(mirror.reconcile).not.toHaveBeenCalled();
  });

  it("does not reconcile before the configured hour even if not yet reconciled today", async () => {
    // 時數判斷要真的用得到，不能只有日期判斷：這裡日期不同（真的還沒校正過），
    // 但現在還沒到 RECONCILE_HOUR，仍然要走增量。
    const { runner, mirror } = mirrorHarness({
      lastReconciledAt: "2026-09-30T10:00:00.000Z", // Taipei 前天
      nowIso: "2026-10-01T16:10:00.000Z", // Taipei 2026-10-02 00:10，還沒到 04:00
    });

    await runner.syncNow();

    expect(mirror.syncOnce).toHaveBeenCalledOnce();
    expect(mirror.reconcile).not.toHaveBeenCalled();
  });

  it("does not start a second tick while a slow reconcile is still in flight", async () => {
    // 節流／防重疊：校正單次呼叫可能耗時遠超過 SYNC_INTERVAL_MS（spec §7 的預算
    // 備忘——大帳本一次校正可能要打數百次 API）。沒有這個防護，下一輪 timer
    // 照樣在 20 秒後觸發，兩個校正同時打 Sheets，配額瞬間翻倍。
    let resolveReconcile!: (value: SyncOutcome) => void;
    const stuckReconcile = new Promise<SyncOutcome>((resolve) => {
      resolveReconcile = resolve;
    });
    const { runner, mirror } = mirrorHarness({
      lastReconciledAt: "2026-10-01T10:00:00.000Z",
      nowIso: "2026-10-01T20:10:00.000Z",
      reconcileResult: stuckReconcile,
    });

    const first = runner.syncNow();
    const second = await runner.syncNow(); // 上一輪還沒結束，這一輪應該直接被跳過

    expect(second).toBeUndefined();
    expect(mirror.reconcile).toHaveBeenCalledOnce();

    resolveReconcile({ kind: "idle" });
    await first;
  });

  it("exposes RECONCILE_HOUR as 4", () => {
    // 釘住 brief 指定的常數值，避免日後被悄悄改掉而沒有測試發現。
    expect(RECONCILE_HOUR).toBe(4);
  });
});
