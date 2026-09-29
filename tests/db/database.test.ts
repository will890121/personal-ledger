import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../../src/db/database.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("openDatabase", () => {
  let pragmaSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pragmaSpy = vi.spyOn(Database.prototype, "pragma");
  });

  afterEach(() => {
    pragmaSpy.mockRestore();
  });

  it("sets full synchronous durability", () => {
    // 規格 §15.2 要求 synchronous=FULL。NORMAL 在主機斷電時可能丟掉最近幾筆已提交交易。
    // 一天幾筆的寫入量下，fsync 成本無關緊要，而這是帳本。
    const database = openDatabase(":memory:");
    databases.push(database);

    // pragma 呼叫需通過 spy 驗證，因為在此 SQLite build synchronous 已預設為 2，
    // 讀回 2 不足以證實我們設定了它。
    expect(pragmaSpy).toHaveBeenCalledWith("synchronous = FULL");
  });

  it("enables WAL journal mode", () => {
    // 規格 §15.2 要求 WAL。記憶體資料庫不支援，pragma 會回 "memory"。
    // 檔案資料庫驗證才能看到真正的 WAL 行為。
    const database = openDatabase(":memory:");
    databases.push(database);

    expect(pragmaSpy).toHaveBeenCalledWith("journal_mode = WAL");
  });

  it("keeps foreign keys enforced", () => {
    const database = openDatabase(":memory:");
    databases.push(database);

    expect(pragmaSpy).toHaveBeenCalledWith("foreign_keys = ON");
  });

  it("uses WAL for a file-backed ledger", () => {
    // 記憶體資料庫不支援 WAL，只有檔案資料庫測得出來。
    // 此測試通過實際行為驗證 WAL 確實啟用（不只是 pragma 呼叫）。
    pragmaSpy.mockRestore();
    const directory = mkdtempSync(join(tmpdir(), "ledger-wal-"));
    const database = openDatabase(join(directory, "ledger.sqlite"));
    databases.push(database);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
  });
});
