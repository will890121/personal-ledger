import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Transformer } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import type { TransactionDraft } from "../../src/domain/ledger.js";
import { logger } from "../../src/logger.js";
import { composeRuntime } from "../../src/main.js";
import { openDatabase } from "../../src/db/database.js";
import type { SheetsClient } from "../../src/ports/sheets-client.js";
import { createGoogleSheetsClient } from "../../src/sheets/google-sheets-client.js";
import { ESCALATE_AFTER_FAILURES } from "../../src/sheets/sheet-failure.js";
import { SYNC_INTERVAL_MS } from "../../src/sheets/sheet-mirror-runner.js";
import { seedM1Ledger } from "../fixtures/m1-ledger.js";
import { seedTransaction } from "../fixtures/sheet-sync-seed.js";

/**
 * 只把 `createGoogleSheetsClient` 包成一個看得到參數的 spy，實作仍然是真的
 * （`importOriginal` 的那一份）。目的是釘住 main.ts 交給它的兩個欄位——
 * 那條接線在正式環境是唯一入口，卻無法從 composeRuntime 的回傳值上觀察到。
 * 用 passthrough 而不是替身：接線測試若連工廠都換掉，就又變成「元件是對的、
 * 但沒人把它接起來」那一類全綠的假保證。
 */
vi.mock("../../src/sheets/google-sheets-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sheets/google-sheets-client.js")>();
  return { ...actual, createGoogleSheetsClient: vi.fn(actual.createGoogleSheetsClient) };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime composition", () => {
  it("migrates a temporary database and exposes a working repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personal-ledger-runtime-"));
    temporaryDirectories.push(directory);

    const runtime = await composeRuntime({
      telegramBotToken: "test-token",
      ownerId: "123",
      databasePath: join(directory, "nested", "ledger.sqlite"),
      timezone: "Asia/Taipei" as const,
      currency: "TWD",
      sheets: null,
    });

    try {
      await runtime.repository.recordInputEvent({
        eventId: "event-1",
        ownerId: "123",
        telegramUpdateId: "update-1",
        sourceType: "telegram",
        sourceRef: "chat:message",
        rawText: "test input",
        receivedAt: "2026-09-18T00:00:00.000Z",
      });

      const draft: TransactionDraft = {
        draftId: "draft-1",
        ownerId: "123",
        requestId: "request-1",
        sourceEventId: "event-1",
        occurredDate: "2026-09-18",
        amount: { amount: "120", currency: "TWD" },
        status: "awaiting_confirmation",
        allocations: [
          {
            allocationId: "allocation-1",
            fundsEffect: "outflow",
            purpose: "expense",
            amount: { amount: "120", currency: "TWD" },
            category: "food",
            subcategory: "meal",
          },
        ],
      };

      await runtime.repository.saveDraft(draft);

      await expect(runtime.repository.getDraft("draft-1")).resolves.toEqual(draft);
      await expect(
        runtime.referenceRepository.findCategoryByKey("123", "expense_dining"),
      ).resolves.toMatchObject({ name: "餐飲" });
      await expect(
        runtime.referenceRepository.findAccountByName("123", "現金"),
      ).resolves.toHaveLength(1);
      expect(
        runtime.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
      ]);
    } finally {
      runtime.close();
    }
  });

  it("upgrades an M1 database and exposes its transaction and summary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personal-ledger-m1-runtime-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "ledger.sqlite");
    const legacyDatabase = openDatabase(databasePath);
    seedM1Ledger(legacyDatabase);
    legacyDatabase.close();

    const config = {
      telegramBotToken: "test-token",
      ownerId: "owner-1",
      databasePath,
      timezone: "Asia/Taipei" as const,
      currency: "TWD" as const,
      sheets: null,
    };
    const runtime = await composeRuntime(config);
    let categoryCount = 0;
    try {
      // AC-24：快照必須在 migration **之前**拍。把 main.ts 那三行搬到 migrate() 之後
      // 會讓 pendingMigrationVersions() 永遠回傳 []，從此再也不會有任何快照——
      // 所以先斷言檔案真的存在，再打開它確認裡面還是升級前的 schema 1，
      // 光看「有一個檔案」分不出拍照時機。
      const snapshots = readdirSync(join(directory, "pre-migration")).filter((file) =>
        file.endsWith(".sqlite"),
      );
      expect(snapshots).toHaveLength(1);
      const snapshotName = snapshots[0];
      if (snapshotName === undefined) throw new Error("no snapshot file");
      const snapshot = openDatabase(join(directory, "pre-migration", snapshotName));
      try {
        expect(
          snapshot.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
        ).toEqual([{ version: 1 }]);
      } finally {
        snapshot.close();
      }

      await expect(
        runtime.repository.getTransaction("owner-1", "m1-transaction"),
      ).resolves.toMatchObject({
        amount: { amount: "120" },
        status: "confirmed",
      });
      await expect(
        runtime.summaryRepository.summarize("owner-1", { from: "2026-09-18", to: "2026-09-18" }),
      ).resolves.toMatchObject({
        actualOutflow: { amount: "120" },
        netPersonalExpense: { amount: "120" },
      });
      expect(
        runtime.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
      ]);
      categoryCount = (
        runtime.database
          .prepare("SELECT COUNT(*) AS count FROM categories WHERE owner_id = ?")
          .get("owner-1") as { count: number }
      ).count;
    } finally {
      runtime.close();
    }

    const restarted = await composeRuntime(config);
    try {
      expect(
        restarted.database
          .prepare("SELECT COUNT(*) AS count FROM categories WHERE owner_id = ?")
          .get("owner-1"),
      ).toEqual({ count: categoryCount });
    } finally {
      restarted.close();
    }
  });

  it("refuses to start when the pre-migration snapshot cannot be taken", async () => {
    // AC-24 的另一半：拍不到照就不准啟動，否則服務會照樣跑 migration——正是
    // 「不以半升級狀態啟動」明文禁止的前一步。把 main.ts 的快照呼叫包成
    // try { } catch { } 吞掉失敗，這條測試必須紅。
    //
    // 不用 mock：在資料目錄裡放一個叫 pre-migration 的**檔案**，快照要建的目錄
    // 就建不起來了——真實的「磁碟滿／目錄不可寫」等價情境。
    const directory = mkdtempSync(join(tmpdir(), "personal-ledger-snapshot-fail-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "ledger.sqlite");
    const legacyDatabase = openDatabase(databasePath);
    seedM1Ledger(legacyDatabase);
    legacyDatabase.close();
    writeFileSync(join(directory, "pre-migration"), "not a directory");

    await expect(
      composeRuntime({
        telegramBotToken: "test-token",
        ownerId: "owner-1",
        databasePath,
        timezone: "Asia/Taipei" as const,
        currency: "TWD" as const,
        sheets: null,
      }),
    ).rejects.toThrow();

    // 而且 migration 不能已經跑掉：資料庫必須還停在升級前的版本。
    const database = openDatabase(databasePath);
    try {
      expect(
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });
});

/**
 * Sheets 鏡像的接線層。這一整個 describe 都刻意**真的走過 `composeRuntime`**，
 * 不只測工廠函式——M4 的 AC-24 就是接線層沒測，讓兩個致命變異（元件是對的、
 * 但沒有人把它接起來）在全綠的測試下活了下來。
 */
describe("runtime 的 Sheets 鏡像接線", () => {
  const OWNER = "123";

  function configFor(directory: string, sheets: AppConfig["sheets"]): AppConfig {
    return {
      telegramBotToken: "123456:test-token",
      ownerId: OWNER,
      databasePath: join(directory, "ledger.sqlite"),
      timezone: "Asia/Taipei" as const,
      currency: "TWD" as const,
      sheets,
    };
  }

  function temporaryDirectory(name: string): string {
    const directory = mkdtempSync(join(tmpdir(), name));
    temporaryDirectories.push(directory);
    return directory;
  }

  /**
   * 永遠失敗的 client，錯誤訊息裡刻意夾一個試算表 id——Google 的 404／403 訊息
   * 真的會這樣回帶，而告警訊息一個字都不能帶到。
   */
  const permanentlyFailing: SheetsClient = {
    readColumns: () =>
      Promise.reject(
        Object.assign(new Error("Requested entity was not found: spreadsheet-secret-id"), {
          code: 403,
        }),
      ),
    updateCells: () => Promise.reject(new Error("not reached")),
  };

  it("沒設定時完全不建立 runner", async () => {
    // 這是「先合併、憑證晚點再說」的那條路徑：兩個變數都沒設，鏡像整個關閉，
    // bot 照常運作。
    const runtime = await composeRuntime(configFor(temporaryDirectory("ledger-no-sheets-"), null));

    try {
      expect(runtime.sheetRunner).toBeNull();
    } finally {
      runtime.close();
    }
  });

  it("設定齊全時建立 runner", async () => {
    // 刻意不注入覆寫：這裡走的是正式環境那條路，真的建出 GoogleAuth 與
    // googleapis 的 client（兩者都是惰性的，不會在這裡碰網路或讀金鑰檔）。
    const runtime = await composeRuntime(
      configFor(temporaryDirectory("ledger-sheets-"), {
        keyFile: join(temporaryDirectory("ledger-key-"), "service-account.json"),
        spreadsheetId: "spreadsheet-1",
      }),
    );

    try {
      expect(runtime.sheetRunner).not.toBeNull();
    } finally {
      runtime.close();
    }
  });

  it("把 keyFile 與 spreadsheetId 各自交給正確的欄位", async () => {
    // 上面那條只斷言「runner 不是 null」：把 main.ts 裡的 keyFile 與 spreadsheetId
    // 互換，測試依然全綠（實測過）。互換之後正式環境會拿試算表 id 當金鑰檔路徑去
    // 認證、拿金鑰檔路徑當試算表 id 去讀寫——兩件事都要等到上線後第一次 tick 才炸，
    // 而且錯誤訊息指向 Google 而不是指向接線。這條把那兩個欄位釘死。
    //
    // 工廠本身仍然是真的（mock factory 直接把 actual 的實作包進 vi.fn），
    // composeRuntime 走的還是正式那條路，只是多了一個看得到參數的位置。
    const keyFile = join(temporaryDirectory("ledger-key-args-"), "service-account.json");
    vi.mocked(createGoogleSheetsClient).mockClear();

    const runtime = await composeRuntime(
      configFor(temporaryDirectory("ledger-sheets-args-"), {
        keyFile,
        spreadsheetId: "spreadsheet-1",
      }),
    );

    try {
      expect(vi.mocked(createGoogleSheetsClient).mock.calls).toEqual([
        [{ keyFile, spreadsheetId: "spreadsheet-1" }],
      ]);
    } finally {
      runtime.close();
    }
  });

  it("close() 真的停掉 sheetRunner 的 interval", async () => {
    // I-2：close() 裡的 sheetRunner?.stop() 沒有被釘住——拿掉那一行，644 條測試
    // 依然全綠。後果：SIGTERM 之後資料庫關了，但 20 秒的 interval 還活著，
    // 下一輪 tick 打在已關閉的連線上，而活著的 interval 讓事件迴圈不結束，
    // 行程永遠不會自然退出（docker stop 只能等到逾時後 SIGKILL）。
    const runtime = await composeRuntime(
      configFor(temporaryDirectory("ledger-sheets-close-"), {
        keyFile: "/nonexistent.json",
        spreadsheetId: "spreadsheet-1",
      }),
      { sheetsClient: permanentlyFailing },
    );

    vi.useFakeTimers();
    try {
      runtime.sheetRunner?.start();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      runtime.close();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runner 的 logError 是真正的 logger.error", async () => {
    // runner 的 tick 是唯一看得到「同步整輪拋錯」的地方。這裡若傳一個 no-op，
    // 正式環境的同步失敗就哪裡都找不到，而所有測試依然全綠（元件測試注入的是
    // 自己的 vi.fn() 替身）。所以只能從 composeRuntime 這一頭驗。
    const runtime = await composeRuntime(
      configFor(temporaryDirectory("ledger-sheets-log-"), {
        keyFile: "/nonexistent.json",
        spreadsheetId: "spreadsheet-1",
      }),
      { sheetsClient: permanentlyFailing },
    );
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      // 讓 loadSyncState 拋錯：這樣 syncNow() 真的會 reject，走的就是 tick 裡
      // 那個 .catch(logError) 分支（Sheets 呼叫失敗會被引擎自己接住，不會 reject）。
      runtime.database.exec("DROP TABLE sheet_sync_state");
      vi.useFakeTimers();
      runtime.sheetRunner?.start();
      await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);

      expect(errorSpy.mock.calls.map((call) => call[0])).toContain("sheet mirror sync failed");
    } finally {
      vi.useRealTimers();
      runtime.close();
    }
  });

  it("連續失敗到門檻時真的送出 Telegram 告警", async () => {
    // Task 8 只定義了 onNeedsAttention 這個注入點。把 main.ts 傳進去的那個函式
    // 換成 no-op，這條必須紅——這正是 M4 AC-24 踩過的坑：元件測試全綠，但沒有
    // 人問過「main.ts 有沒有真的把它接起來」。
    const runtime = await composeRuntime(
      configFor(temporaryDirectory("ledger-sheets-alert-"), {
        keyFile: "/nonexistent.json",
        spreadsheetId: "spreadsheet-1",
      }),
      { sheetsClient: permanentlyFailing },
    );
    const sent: { method: string; payload: unknown }[] = [];
    const capture: Transformer = (_previous, method, payload) => {
      sent.push({ method, payload });
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 1,
          date: 1_758_157_200,
          chat: { id: 123, type: "private", first_name: "Owner" },
        },
      } as never);
    };
    runtime.bot.api.config.use(capture);

    try {
      // 要有一筆變更，鏡像才會真的去打 Sheets（沒有變更就一次呼叫都不發）。
      seedTransaction(runtime.database, OWNER, {
        id: "t1",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
      for (let attempt = 0; attempt < ESCALATE_AFTER_FAILURES; attempt += 1) {
        await expect(runtime.sheetRunner?.syncNow()).resolves.toMatchObject({ kind: "failed" });
      }

      const messages = sent.filter((call) => call.method === "sendMessage");
      expect(messages).toHaveLength(1);
      const payload = messages[0]?.payload as { text: string; chat_id: unknown };
      expect(payload.text).toContain("Sheets 鏡像連續失敗");
      expect(payload.text).toContain("permanent:403");
      // 錯誤原文不得出現：Google 的訊息會回帶試算表 id。
      expect(payload.text).not.toContain("spreadsheet-secret-id");
      // I-3：收件人沒被斷言的話，把 chatId 寫死成別的 id 也能全綠——
      // 使用者看到的後果跟告警完全不會送出一樣：訊息永遠到不了正確的人。
      expect(payload.chat_id).toBe(OWNER);
    } finally {
      runtime.close();
    }
  });
});
