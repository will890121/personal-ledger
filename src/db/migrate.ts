import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

const INITIAL_MIGRATION = 1;

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = database
    .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get(INITIAL_MIGRATION);

  if (applied) {
    return;
  }

  const sql = readFileSync(new URL("./migrations/0001_initial.sql", import.meta.url), "utf8");
  const apply = database.transaction(() => {
    database.exec(sql);
    database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(INITIAL_MIGRATION);
  });

  apply.immediate();
}
