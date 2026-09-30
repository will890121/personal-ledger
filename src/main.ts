import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import type { Bot } from "grammy";

import { type AppConfig, loadConfig } from "./config.js";
import { bootstrapReferenceData } from "./db/bootstrap-reference-data.js";
import { openDatabase } from "./db/database.js";
import { migrate, SCHEMA_VERSION } from "./db/migrate.js";
import { takePreMigrationSnapshot } from "./db/pre-migration-snapshot.js";
import { SqliteLedgerRepository } from "./db/sqlite-ledger-repository.js";
import { SqliteReferenceRepository } from "./db/sqlite-reference-repository.js";
import { SqliteSheetSyncRepository } from "./db/sqlite-sheet-sync-repository.js";
import { SqliteSummaryRepository } from "./db/sqlite-summary-repository.js";
import { logger } from "./logger.js";
import type { SheetsClient } from "./ports/sheets-client.js";
import { createGoogleSheetsClient } from "./sheets/google-sheets-client.js";
import { createSheetMirror } from "./sheets/sheet-mirror.js";
import { createSheetMirrorRunner, type SheetMirrorRunner } from "./sheets/sheet-mirror-runner.js";
import { createSheetsAttentionNotifier } from "./sheets/notify-sheets-attention.js";
import { createLedgerBot, registerCommandMenu } from "./telegram/create-bot.js";
import type { OutboxRunner } from "./telegram/outbox-runner.js";
import { dateInTimezone, timeOfDayInTimezone } from "./timezone.js";

export interface Runtime {
  readonly database: Database.Database;
  readonly repository: SqliteLedgerRepository;
  readonly referenceRepository: SqliteReferenceRepository;
  readonly summaryRepository: SqliteSummaryRepository;
  readonly bot: Bot;
  readonly outboxRunner: OutboxRunner;
  /** `config.sheets` 為 null（沒有憑證）時是 null：鏡像整個關閉，bot 照常運作。 */
  readonly sheetRunner: SheetMirrorRunner | null;
  readonly close: () => void;
}

/**
 * 只給測試用的覆寫。沿用 `createLedgerBot` 的 `outboxRunner` 覆寫欄位裁決過的
 * 做法：接線層要能被真的走一遍（M4 的 AC-24 就是接線層沒測而讓兩個致命變異存活），
 * 而真正的 Google client 需要憑證與網路。**正式環境永遠不傳這個參數。**
 */
export interface RuntimeOverrides {
  readonly sheetsClient?: SheetsClient;
}

// migration 失敗時，快照路徑是唯一能讓人手動還原的線索，所以一定要記下來；
// 沒有拍照（代表沒有待套用的 migration）就沒有東西可記。
function recordPreMigrationSnapshot(snapshotPath: string | null): void {
  if (snapshotPath === null) return;
  logger.info("migration 前已建立快照", { snapshot: snapshotPath });
}

/**
 * Sheets 鏡像的整條接線，`config.sheets` 為 null 就完全不建立。
 *
 * 兩個依賴刻意從這裡注入，因為 `src/sheets/` 不能 import grammY：
 *   - `logError` 要拿到真正的 `logger.error`。runner 的 tick 是唯一會看到
 *     「同步整輪拋錯」的地方（Node 24 預設會讓漏接的拒絕殺掉行程，所以那裡一定
 *     要有 .catch()）；這裡若傳一個 no-op，正式環境的同步失敗就記在任何地方都
 *     找不到，而所有測試依然全綠——測試注入的是自己的替身。
 *   - `onNeedsAttention` 要真的送出 Telegram 訊息。Task 8 只定義了注入點。
 */
function composeSheetRunner(parts: {
  readonly config: AppConfig;
  readonly database: Database.Database;
  readonly summaryRepository: SqliteSummaryRepository;
  readonly bot: Bot;
  readonly overrides: RuntimeOverrides;
}): SheetMirrorRunner | null {
  const { config, database, summaryRepository, bot, overrides } = parts;
  if (config.sheets === null) return null;

  const syncRepository = new SqliteSheetSyncRepository(database);
  const sheets =
    overrides.sheetsClient ??
    createGoogleSheetsClient({
      keyFile: config.sheets.keyFile,
      spreadsheetId: config.sheets.spreadsheetId,
    });
  const logError = (message: string, fields?: Record<string, unknown>): void => {
    logger.error(message, fields);
  };
  const mirror = createSheetMirror({
    ownerId: config.ownerId,
    sheets,
    syncRepository,
    summaryRepository,
    now: () => new Date(),
    onNeedsAttention: createSheetsAttentionNotifier({
      chatId: config.ownerId,
      api: { sendMessage: (chatId, text) => bot.api.sendMessage(chatId, text) },
      logError,
    }),
  });

  return createSheetMirrorRunner({
    mirror,
    syncRepository,
    ownerId: config.ownerId,
    timezone: config.timezone,
    now: () => new Date(),
    logError,
  });
}

export async function composeRuntime(
  config: AppConfig,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  const dataDirectory = dirname(resolve(config.databasePath));
  mkdirSync(dataDirectory, { recursive: true });

  const database = openDatabase(config.databasePath);
  try {
    // 有 migration 待套用時才拍照:失敗後才有東西能還原(AC-24)。用 SCHEMA_VERSION
    // 當檔名裡的目標版本——它本來就是「從 migrations 清單推導出的最新版本」,不必
    // 另外再做一個 latestMigrationVersion() 講同一件事。
    const snapshot = takePreMigrationSnapshot(database, dataDirectory, SCHEMA_VERSION, new Date());
    recordPreMigrationSnapshot(snapshot);
    migrate(database);
    const referenceRepository = new SqliteReferenceRepository(database);
    await bootstrapReferenceData(referenceRepository, config.ownerId);
    const repository = new SqliteLedgerRepository(database);
    const summaryRepository = new SqliteSummaryRepository(database);
    const { bot, outboxRunner } = createLedgerBot({
      token: config.telegramBotToken,
      ownerId: config.ownerId,
      repository,
      referenceRepository,
      summaryRepository,
      generateId: randomUUID,
      now: () => new Date(),
      today: () => dateInTimezone(new Date(), config.timezone),
      timeOfDay: (at) => timeOfDayInTimezone(at, config.timezone),
      schemaVersion: SCHEMA_VERSION,
    });

    const sheetRunner = composeSheetRunner({
      config,
      database,
      summaryRepository,
      bot,
      overrides,
    });

    return {
      database,
      repository,
      referenceRepository,
      summaryRepository,
      bot,
      outboxRunner,
      sheetRunner,
      close: () => {
        // 先停 timer 再關資料庫：反過來的話下一輪 tick 會撞上一個已經關掉的
        // 連線，而那個拒絕只會變成日誌裡一行看不懂的錯誤。
        sheetRunner?.stop();
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * 縱深防禦，不是真正的修正：漏接的 promise 拒絕在 Node 24 的預設
 * （--unhandled-rejections=throw）下會直接殺掉行程，而 compose.yaml 的
 * restart: unless-stopped 會把它變成無盡的 crash loop——對一個必須保持可達的 bot
 * 來說，靜默的 crash loop 比一行被記錄下來的異常糟糕得多。create-bot.ts 的
 * bot.catch 對 handler 路徑講的是同一個原則（「任何例外都不該讓 bot 失聯」），
 * 這裡把同一個原則補在行程層級。
 *
 * 真正該接住拒絕的地方是產生它的那一段程式（例如 outbox-runner 的 drain 迴圈
 * 自己的 .catch()）；走到這裡代表有人漏了，所以一定要留下一筆記錄，而且要走
 * 會遮罩的 logger，不能讓 Node runtime 把未遮罩的 stack trace 直接印到 stderr。
 */
export function installUnhandledRejectionGuard(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("unhandled promise rejection", { error: reason });
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  installUnhandledRejectionGuard();
  const config = loadConfig(env);
  const runtime = await composeRuntime(config);

  logger.info("Ledger Bot runtime ready", {
    databasePath: config.databasePath,
    timezone: config.timezone,
    currency: config.currency,
    // 只記「開著還是關著」。試算表 id 與金鑰路徑一個都不記——logger 的拒絕清單
    // 也擋了 spreadsheetId，但第一道防線是呼叫端本來就不要交出去。
    sheetsMirror: runtime.sheetRunner === null ? "off" : "on",
  });

  if (env.LEDGER_STARTUP_CHECK === "1") {
    runtime.close();
    return;
  }

  // setMyCommands 是一次網路呼叫，跟背景輪詢一樣只在真正跑起來的行程裡做一次：
  // LEDGER_STARTUP_CHECK 探測已經在上面 return 掉，不會走到這裡，探測仍然能快速結束。
  await registerCommandMenu(runtime.bot);

  // 背景遞送迴圈只在真正跑起來的行程裡啟動：LEDGER_STARTUP_CHECK 探測與測試都只是
  // 建構 runtime 就結束，不該讓每一次建構都掛一個真的 interval。
  runtime.outboxRunner.start();
  // 沒有 Sheets 憑證時 sheetRunner 是 null：鏡像整個關閉，bot 照常運作。
  runtime.sheetRunner?.start();

  const stop = (): void => {
    void runtime.bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await runtime.bot.start();
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    runtime.outboxRunner.stop();
    // sheetRunner 的 stop() 在 close() 裡（見 composeRuntime），順序才保證是
    // 「先停 timer 再關資料庫」。
    runtime.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    // 原本直接印 error.message：對本專案自己丟出的固定字串 Error 沒問題，
    // 但换成 SqliteError／ZodError 時 message 會夾帶 SQL 或使用者輸入。
    // 交給 logger 的 error 欄位，遮罩規則跟其他錯誤日誌一致。
    logger.error("Ledger Bot failed to start", { error });
    process.exitCode = 1;
  });
}
