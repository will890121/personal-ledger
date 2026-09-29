import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("openDatabase", () => {
  it("opens the ledger in WAL with full synchronous durability", () => {
    // 規格 §15.2 要求 WAL；synchronous=FULL 讓主機斷電也不會丟掉已提交的交易。
    // 一天幾筆的寫入量下，fsync 成本無關緊要，而這是帳本。
    const database = openDatabase(":memory:");
    databases.push(database);

    // 記憶體資料庫回報 "memory"，檔案資料庫才會回 "wal"，因此用暫存檔驗證。
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
  });

  it("keeps foreign keys enforced", () => {
    const database = openDatabase(":memory:");
    databases.push(database);

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("uses WAL for a file-backed ledger", () => {
    // 記憶體資料庫不支援 WAL，只有檔案資料庫測得出來。
    const directory = mkdtempSync(join(tmpdir(), "ledger-wal-"));
    const database = openDatabase(join(directory, "ledger.sqlite"));
    databases.push(database);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
  });
});
