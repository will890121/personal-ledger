import type Database from "better-sqlite3";

import type {
  MirrorAllocation,
  MirrorTransaction,
  SheetSyncRepository,
  SheetSyncState,
  SyncCursor,
} from "../ports/sheet-sync-repository.js";

interface SheetSyncStateRow {
  owner_id: string;
  cursor_updated_at: string | null;
  cursor_transaction_id: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_reconciled_at: string | null;
}

interface TransactionRow {
  transaction_id: string;
  occurred_date: string;
  occurred_time: string | null;
  amount: string;
  account_from_name: string | null;
  account_to_name: string | null;
  merchant_name: string | null;
  counterparty_name: string | null;
  note: string | null;
  raw_input_snapshot: string | null;
  status: string;
  confirmed_at: string;
  updated_at: string;
}

interface AllocationRow {
  allocation_id: string;
  transaction_id: string;
  funds_effect: string;
  purpose: string;
  amount: string;
  category_snapshot: string;
  subcategory_snapshot: string | null;
  counterparty_name: string | null;
  note: string | null;
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

  public listChangedTransactions(
    ownerId: string,
    cursor: SyncCursor | null,
    limit: number,
  ): Promise<MirrorTransaction[]> {
    // 游標語意是嚴格 >，兩層比較都是。游標存的是 (updated_at, transaction_id) 這個
    // 元組，而 transaction_id 唯一，所以元組是全序——「嚴格大於游標」剛好等於
    // 「排在游標之後」，同毫秒但 id 較大的那一列仍會被 transaction_id > 撈到，
    // 一筆都不會漏。（會漏的是游標只存 updated_at 的設計，那不是這裡的設計。）
    // 反過來寫成 >= 的代價很實在：游標那一列每一輪都被重撈，系統永遠靜不下來，
    // 閒置時照樣每輪三讀一寫，而摘要分頁的「更新時間」欄也會一直跳動。
    const cursorClause = cursor
      ? "AND (t.updated_at > @cursorUpdatedAt OR (t.updated_at = @cursorUpdatedAt AND t.transaction_id > @cursorTransactionId))"
      : "";

    const transactionRows = this.database
      .prepare(
        `SELECT t.transaction_id, t.occurred_date, t.occurred_time, t.amount,
                af.name AS account_from_name, at2.name AS account_to_name,
                m.name AS merchant_name, cp.name AS counterparty_name,
                t.note, t.raw_input_snapshot, t.status, t.confirmed_at, t.updated_at
         FROM transactions t
         LEFT JOIN accounts af ON af.account_id = t.account_from_id
         LEFT JOIN accounts at2 ON at2.account_id = t.account_to_id
         LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
         LEFT JOIN counterparties cp ON cp.counterparty_id = t.counterparty_id
         WHERE t.owner_id = @ownerId ${cursorClause}
         ORDER BY t.updated_at, t.transaction_id
         LIMIT @limit`,
      )
      .all({
        ownerId,
        limit,
        cursorUpdatedAt: cursor?.updatedAt ?? null,
        cursorTransactionId: cursor?.transactionId ?? null,
      }) as TransactionRow[];

    if (transactionRows.length === 0) return Promise.resolve([]);

    const ids = transactionRows.map((row) => row.transaction_id);
    const placeholders = ids.map(() => "?").join(", ");
    const allocationRows = this.database
      .prepare(
        `SELECT a.allocation_id, a.transaction_id, a.funds_effect, a.purpose, a.amount,
                a.category_snapshot, a.subcategory_snapshot,
                cp.name AS counterparty_name, a.note
         FROM allocations a
         LEFT JOIN counterparties cp ON cp.counterparty_id = a.counterparty_id
         WHERE a.transaction_id IN (${placeholders})
         ORDER BY a.transaction_id, a.rowid`,
      )
      .all(...ids) as AllocationRow[];

    const byTransaction = new Map<string, MirrorAllocation[]>();
    for (const row of allocationRows) {
      const list = byTransaction.get(row.transaction_id) ?? [];
      list.push({
        allocationId: row.allocation_id,
        fundsEffect: row.funds_effect,
        purpose: row.purpose,
        amount: row.amount,
        categoryName: row.category_snapshot,
        subcategoryName: row.subcategory_snapshot,
        counterpartyName: row.counterparty_name,
        note: row.note,
      });
      byTransaction.set(row.transaction_id, list);
    }

    return Promise.resolve(
      transactionRows.map((row) => ({
        transactionId: row.transaction_id,
        occurredDate: row.occurred_date,
        occurredTime: row.occurred_time,
        amount: row.amount,
        accountFromName: row.account_from_name,
        accountToName: row.account_to_name,
        merchantName: row.merchant_name,
        counterpartyName: row.counterparty_name,
        note: row.note,
        rawInputSnapshot: row.raw_input_snapshot,
        status: row.status,
        confirmedAt: row.confirmed_at,
        updatedAt: row.updated_at,
        allocations: byTransaction.get(row.transaction_id) ?? [],
      })),
    );
  }
}
