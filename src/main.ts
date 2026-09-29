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
import { createLedgerBot } from "./telegram/create-bot.js";
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

// 下一個 task 會接上不外洩機敏資料的 logger,以及禁用 console.* 的 no-console 規則。
// 這個函式是刻意留的掛勾:等 logger 進來後,把裡面換成
// logger.info("migration 前已建立快照", { snapshot: snapshotPath }) 就好,
// 不需要現在塞 console.info 讓下一個 task 要拆掉。
function recordPreMigrationSnapshot(snapshotPath: string | null): void {
  if (snapshotPath === null) return;
}

export async function composeRuntime(config: AppConfig): Promise<Runtime> {
  mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });

  const database = openDatabase(config.databasePath);
  try {
    // 有 migration 待套用時才拍照:失敗後才有東西能還原(AC-24)。用 SCHEMA_VERSION
    // 當檔名裡的目標版本——它本來就是「從 migrations 清單推導出的最新版本」,不必
    // 另外再做一個 latestMigrationVersion() 講同一件事。
    const snapshot = takePreMigrationSnapshot(
      database,
      dirname(resolve(config.databasePath)),
      SCHEMA_VERSION,
      new Date(),
    );
    // 下一個 task 會加上不外洩機敏資料的 logger,以及禁用 console.* 的 no-console 規則。
    // 快照路徑目前沒有地方能安全印出來,先留一個掛勾;等 logger 進來後,把這裡換成
    // logger.info("migration 前已建立快照", { snapshot }) 即可,不要現在塞 console.info
    // 讓下一個 task 要拆掉。
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

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const runtime = await composeRuntime(config);

  console.info("Ledger Bot runtime ready", {
    databasePath: config.databasePath,
    timezone: config.timezone,
    currency: config.currency,
  });

  if (env.LEDGER_STARTUP_CHECK === "1") {
    runtime.close();
    return;
  }

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
    console.error(error instanceof Error ? error.message : "Ledger Bot failed to start");
    process.exitCode = 1;
  });
}
