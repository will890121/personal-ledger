import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

const migrations = [
  { version: 1, url: new URL("./migrations/0001_initial.sql", import.meta.url) },
  { version: 2, url: new URL("./migrations/0002_accounting_core.sql", import.meta.url) },
  { version: 3, url: new URL("./migrations/0003_conversation_state.sql", import.meta.url) },
  { version: 4, url: new URL("./migrations/0004_settings.sql", import.meta.url) },
] as const;

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
