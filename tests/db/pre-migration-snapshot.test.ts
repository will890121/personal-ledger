import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { takePreMigrationSnapshot } from "../../src/db/pre-migration-snapshot.js";

// 建立版本 7 資料庫要套用的 migration 檔案,按順序、不含 0008——那一版才是我們要
// 測「升級前拍照」的目標版本。
const MIGRATION_FILES_THROUGH_V7 = [
  "0001_initial.sql",
  "0002_accounting_core.sql",
  "0003_conversation_state.sql",
  "0004_settings.sql",
  "0005_advance_recovery.sql",
  "0006_dining_category.sql",
  "0007_user_category_keywords.sql",
];

const temporaryDirectories: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  // 先關資料庫再刪目錄:Windows 上刪除還開著的檔案會失敗,這裡雖然是 macOS/Linux
  // 也養成同樣的順序。
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 全新資料庫,已經升級到最新版——用來驗證「沒有待套用 migration 就不拍快照」。
function freshLedger(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "pre-migration-snapshot-fresh-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "ledger.sqlite");
  const database = openDatabase(databasePath);
  migrate(database);
  database.close();
  return { directory, databasePath };
}

// 手動套用到指定的舊版本,不透過 migrate()——migrate() 一律套用到最新版,沒辦法
// 用它停在中途。做法跟 tests/fixtures/m1-ledger.js 建立舊版資料庫的方式一致。
function ledgerAtVersion(version: number): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), `pre-migration-snapshot-v${String(version)}-`));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "ledger.sqlite");
  const database = openDatabase(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (let appliedVersion = 1; appliedVersion <= version; appliedVersion += 1) {
    const file = MIGRATION_FILES_THROUGH_V7[appliedVersion - 1];
    if (!file) throw new Error(`no fixture migration file for version ${String(appliedVersion)}`);
    database.exec(
      readFileSync(new URL(`../../src/db/migrations/${file}`, import.meta.url), "utf8"),
    );
    database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(appliedVersion);
  }
  database.close();
  return { directory, databasePath };
}

describe("pre-migration snapshot", () => {
  it("writes a snapshot only when a migration is actually pending", () => {
    const { directory, databasePath } = freshLedger(); // 已升級到最新
    const database = openDatabase(databasePath);
    databases.push(database);

    expect(takePreMigrationSnapshot(database, directory, 8, new Date())).toBeNull();
    expect(existsSync(join(directory, "pre-migration"))).toBe(false);
  });

  it("snapshots an old database before upgrading it", () => {
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);
    databases.push(database);

    const snapshot = takePreMigrationSnapshot(database, directory, 8, new Date());

    expect(snapshot).toMatch(/pre-migration\/.*-8\.sqlite$/);
    // 快照本身必須是可用的資料庫,否則它不是備份只是檔案。
    const restored = openDatabase(snapshot ?? "");
    databases.push(restored);
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(restored.prepare("SELECT max(version) AS v FROM schema_migrations").get()).toEqual({
      v: 7,
    });
  });

  it("captures data still sitting in the write-ahead log", () => {
    // VACUUM INTO 存在的全部理由。少了這條,把它換成 copyFileSync 四條原本的測試全綠——
    // 沒有一條檢查得出來——而複製檔案在 WAL 模式下會漏掉尚未 checkpoint 的已提交資料。
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);
    databases.push(database);
    database.exec("CREATE TABLE wal_probe (id INTEGER PRIMARY KEY)");
    database.prepare("INSERT INTO wal_probe (id) VALUES (1)").run();

    const snapshot = takePreMigrationSnapshot(database, directory, 8, new Date());

    const restored = openDatabase(snapshot ?? "");
    databases.push(restored);
    expect(restored.prepare("SELECT count(*) AS total FROM wal_probe").get()).toEqual({
      total: 1,
    });
  });

  it("keeps the newest snapshot when the target version crosses into two digits", () => {
    // 版本從個位數升到兩位數時,若把版本放在檔名最前面,字典序會把「10-…」排到
    // 「9-…」前面;修剪拿排序後最前面的當「最舊」刪掉,結果刪的反而是最新那份。
    // 這條測試在版本前綴的舊命名法下會失敗,在時間戳前綴的命名法下才會過。
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);
    databases.push(database);
    const folder = join(directory, "pre-migration");

    takePreMigrationSnapshot(database, directory, 9, new Date(Date.UTC(2026, 8, 30, 1, 0)));
    takePreMigrationSnapshot(database, directory, 9, new Date(Date.UTC(2026, 8, 30, 1, 1)));
    takePreMigrationSnapshot(database, directory, 9, new Date(Date.UTC(2026, 8, 30, 1, 2)));
    const newest = takePreMigrationSnapshot(
      database,
      directory,
      10,
      new Date(Date.UTC(2026, 8, 30, 1, 3)),
    );

    const files = readdirSync(folder).sort();
    expect(files).toHaveLength(3);
    expect(newest).not.toBeNull();
    expect(existsSync(newest ?? "")).toBe(true);
  });

  it("keeps only the three most recent snapshots", () => {
    // 同一個 volume 裝不下無限份,而且舊的沒有價值。
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);
    databases.push(database);
    const folder = join(directory, "pre-migration");

    for (let minute = 0; minute < 5; minute += 1) {
      takePreMigrationSnapshot(database, directory, 8, new Date(Date.UTC(2026, 8, 30, 1, minute)));
    }

    const files = readdirSync(folder).sort();
    expect(files).toHaveLength(3);
    // 留下的是最新的三份。
    expect(files[0]).toContain("01-02");
    expect(files[2]).toContain("01-04");
  });

  it("leaves the snapshot in place when the migration then fails", () => {
    // AC-24 的重點:快照要在失敗之後還找得到,否則沒有東西可以還原。
    const { directory, databasePath } = ledgerAtVersion(7);
    const database = openDatabase(databasePath);
    databases.push(database);
    const snapshot = takePreMigrationSnapshot(database, directory, 8, new Date());
    // 讓 migration 失敗:先佔用它要建立的資料表名稱。
    database.exec("CREATE TABLE outbox_messages (nope TEXT)");

    expect(() => {
      migrate(database);
    }).toThrow();

    expect(existsSync(snapshot ?? "")).toBe(true);
    expect(database.prepare("SELECT max(version) AS v FROM schema_migrations").get()).toEqual({
      v: 7,
    });
  });
});
