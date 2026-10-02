import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/db/migrate.js";
import { SqliteSheetSyncRepository } from "../../src/db/sqlite-sheet-sync-repository.js";

describe("SqliteSheetSyncRepository", () => {
  let database: Database.Database;
  let repository: SqliteSheetSyncRepository;

  beforeEach(() => {
    database = new Database(":memory:");
    migrate(database);
    repository = new SqliteSheetSyncRepository(database);
  });

  it("returns a zero state for an owner that has never synced", async () => {
    // 從未同步過必須回傳游標為 null 而不是拋錯或回傳空字串——null 是「走全表校正」
    // 的訊號，空字串會被字典序比較當成「比任何時間都早」而誤入增量路徑。
    const state = await repository.loadSyncState("owner-1");

    expect(state.cursorUpdatedAt).toBeNull();
    expect(state.cursorTransactionId).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastSuccessAt).toBeNull();
  });

  it("round-trips a saved state", async () => {
    await repository.saveSyncState({
      ownerId: "owner-1",
      cursorUpdatedAt: "2026-10-01T00:00:00.000Z",
      cursorTransactionId: "txn-9",
      lastSuccessAt: "2026-10-01T00:00:01.000Z",
      lastError: null,
      consecutiveFailures: 0,
      lastReconciledAt: "2026-10-01T20:00:00.000Z",
    });

    expect(await repository.loadSyncState("owner-1")).toEqual({
      ownerId: "owner-1",
      cursorUpdatedAt: "2026-10-01T00:00:00.000Z",
      cursorTransactionId: "txn-9",
      lastSuccessAt: "2026-10-01T00:00:01.000Z",
      lastError: null,
      consecutiveFailures: 0,
      lastReconciledAt: "2026-10-01T20:00:00.000Z",
    });
  });

  it("overwrites rather than accumulating rows for the same owner", async () => {
    // PRIMARY KEY (owner_id) 是「一個 owner 一列」這條設計的執行點。若 saveSyncState
    // 寫成 INSERT 而非 upsert，第二次儲存會拋 constraint 錯誤；若改成多列，
    // loadSyncState 會隨機讀到舊游標而重複同步。
    const base = {
      ownerId: "owner-1",
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      lastReconciledAt: null,
    };
    await repository.saveSyncState({
      ...base,
      cursorUpdatedAt: "2026-10-01T00:00:00.000Z",
      cursorTransactionId: "txn-1",
    });
    await repository.saveSyncState({
      ...base,
      cursorUpdatedAt: "2026-10-02T00:00:00.000Z",
      cursorTransactionId: "txn-2",
    });

    const rows = database.prepare("SELECT count(*) AS total FROM sheet_sync_state").get() as {
      total: number;
    };
    expect(rows.total).toBe(1);
    expect((await repository.loadSyncState("owner-1")).cursorTransactionId).toBe("txn-2");
  });
});
