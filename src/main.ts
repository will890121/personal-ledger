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
import { SqliteSummaryRepository } from "./db/sqlite-summary-repository.js";
import { logger } from "./logger.js";
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
  readonly close: () => void;
}

// migration 失敗時，快照路徑是唯一能讓人手動還原的線索，所以一定要記下來；
// 沒有拍照（代表沒有待套用的 migration）就沒有東西可記。
function recordPreMigrationSnapshot(snapshotPath: string | null): void {
  if (snapshotPath === null) return;
  logger.info("migration 前已建立快照", { snapshot: snapshotPath });
}

export async function composeRuntime(config: AppConfig): Promise<Runtime> {
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

    return {
      database,
      repository,
      referenceRepository,
      summaryRepository,
      bot,
      outboxRunner,
      close: () => database.close(),
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
