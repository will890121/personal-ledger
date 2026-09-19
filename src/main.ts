import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import type { Bot } from "grammy";

import { type AppConfig, loadConfig } from "./config.js";
import { bootstrapReferenceData } from "./db/bootstrap-reference-data.js";
import { openDatabase } from "./db/database.js";
import { migrate } from "./db/migrate.js";
import { SqliteLedgerRepository } from "./db/sqlite-ledger-repository.js";
import { SqliteReferenceRepository } from "./db/sqlite-reference-repository.js";
import { SqliteSummaryRepository } from "./db/sqlite-summary-repository.js";
import { createLedgerBot } from "./telegram/create-bot.js";

export interface Runtime {
  readonly database: Database.Database;
  readonly repository: SqliteLedgerRepository;
  readonly referenceRepository: SqliteReferenceRepository;
  readonly summaryRepository: SqliteSummaryRepository;
  readonly bot: Bot;
  readonly close: () => void;
}

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const { year, month, day } = values;
  if (!year || !month || !day) {
    throw new Error(`Unable to format date in timezone: ${timezone}`);
  }

  return `${year}-${month}-${day}`;
}

export async function composeRuntime(config: AppConfig): Promise<Runtime> {
  mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });

  const database = openDatabase(config.databasePath);
  try {
    migrate(database);
    const referenceRepository = new SqliteReferenceRepository(database);
    await bootstrapReferenceData(referenceRepository, config.ownerId);
    const repository = new SqliteLedgerRepository(database);
    const summaryRepository = new SqliteSummaryRepository(database);
    const bot = createLedgerBot({
      token: config.telegramBotToken,
      ownerId: config.ownerId,
      repository,
      referenceRepository,
      summaryRepository,
      generateId: randomUUID,
      now: () => new Date(),
      today: () => dateInTimezone(new Date(), config.timezone),
    });

    return {
      database,
      repository,
      referenceRepository,
      summaryRepository,
      bot,
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
