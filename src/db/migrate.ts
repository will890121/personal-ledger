import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

const migrations = [
  { version: 1, url: new URL("./migrations/0001_initial.sql", import.meta.url) },
  { version: 2, url: new URL("./migrations/0002_accounting_core.sql", import.meta.url) },
  { version: 3, url: new URL("./migrations/0003_conversation_state.sql", import.meta.url) },
  { version: 4, url: new URL("./migrations/0004_settings.sql", import.meta.url) },
  { version: 5, url: new URL("./migrations/0005_advance_recovery.sql", import.meta.url) },
  { version: 6, url: new URL("./migrations/0006_dining_category.sql", import.meta.url) },
  { version: 7, url: new URL("./migrations/0007_user_category_keywords.sql", import.meta.url) },
  { version: 8, url: new URL("./migrations/0008_outbox.sql", import.meta.url) },
] as const;

// /status 顯示「schema 版本」讓使用者（其實是開發者自己）確認正式環境跑的是哪一版
// migration；直接從這份清單推導，而不是另外維護一個常數，兩邊才不會漏同步。
// 用 Math.max 而不是取最後一個元素：noUncheckedIndexedAccess 底下陣列索引的型別
// 一律帶著 undefined，reduce 出最大值不必再處理那個其實不會發生的情況。
export const SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

// migration 前要不要拍快照，取決於還有沒有版本沒套用到這個資料庫。schema_migrations
// 表不存在代表全新資料庫，沒有東西需要保護，回傳空陣列而不是拋錯或視為「全部待套用」。
export function pendingMigrationVersions(database: Database.Database): number[] {
  const migrationsTableExists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!migrationsTableExists) return [];

  const appliedVersions = new Set(
    (database.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );
  return migrations
    .filter((migration) => !appliedVersions.has(migration.version))
    .map((migration) => migration.version);
}

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const migration of migrations) {
    const applied = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(migration.version);
    if (applied) continue;

    const sql = readFileSync(migration.url, "utf8");
    const apply = database.transaction(() => {
      database.exec(sql);
      assertForeignKeys(database);
      database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
    });

    // PRAGMA foreign_keys 在 transaction 內是 no-op，因此必須在進入 transaction 之前
    // 關閉；重建被其他資料表參照的表（例如 drafts）才不會觸發外鍵違規。
    // foreign_key_check 不受此開關影響，完整性斷言仍然有效。
    const foreignKeysEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
    if (foreignKeysEnabled) database.pragma("foreign_keys = OFF");
    try {
      apply.immediate();
    } finally {
      if (foreignKeysEnabled) database.pragma("foreign_keys = ON");
    }
  }

  assertForeignKeys(database);
}

function assertForeignKeys(database: Database.Database): void {
  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error("database migration failed foreign key check");
  }
}
