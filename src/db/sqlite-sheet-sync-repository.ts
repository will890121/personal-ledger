import type Database from "better-sqlite3";

import type { SheetSyncRepository, SheetSyncState } from "../ports/sheet-sync-repository.js";

interface SheetSyncStateRow {
  owner_id: string;
  cursor_updated_at: string | null;
  cursor_transaction_id: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_reconciled_at: string | null;
}

export class SqliteSheetSyncRepository implements SheetSyncRepository {
  public constructor(private readonly database: Database.Database) {}

  public loadSyncState(ownerId: string): Promise<SheetSyncState> {
    const row = this.database
      .prepare("SELECT * FROM sheet_sync_state WHERE owner_id = ?")
      .get(ownerId) as SheetSyncStateRow | undefined;

    // 沒有列不是錯誤，是「還沒同步過」。回傳游標為 null 的零狀態，讓呼叫端走全表校正。
    if (!row) {
      return Promise.resolve({
        ownerId,
        cursorUpdatedAt: null,
        cursorTransactionId: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        lastReconciledAt: null,
      });
    }

    return Promise.resolve({
      ownerId: row.owner_id,
      cursorUpdatedAt: row.cursor_updated_at,
      cursorTransactionId: row.cursor_transaction_id,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
      lastReconciledAt: row.last_reconciled_at,
    });
  }

  public saveSyncState(state: SheetSyncState): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO sheet_sync_state (
           owner_id, cursor_updated_at, cursor_transaction_id,
           last_success_at, last_error, consecutive_failures, last_reconciled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id) DO UPDATE SET
           cursor_updated_at = excluded.cursor_updated_at,
           cursor_transaction_id = excluded.cursor_transaction_id,
           last_success_at = excluded.last_success_at,
           last_error = excluded.last_error,
           consecutive_failures = excluded.consecutive_failures,
           last_reconciled_at = excluded.last_reconciled_at`,
      )
      .run(
        state.ownerId,
        state.cursorUpdatedAt,
        state.cursorTransactionId,
        state.lastSuccessAt,
        state.lastError,
        state.consecutiveFailures,
        state.lastReconciledAt,
      );
    return Promise.resolve();
  }
}
