import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

const migrations = [
  { version: 1, url: new URL("./migrations/0001_initial.sql", import.meta.url) },
  { version: 2, url: new URL("./migrations/0002_accounting_core.sql", import.meta.url) },
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
    apply.immediate();
  }

  assertForeignKeys(database);
}

function assertForeignKeys(database: Database.Database): void {
  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error("database migration failed foreign key check");
  }
}
