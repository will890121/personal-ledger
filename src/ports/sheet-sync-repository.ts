export interface SheetSyncState {
  readonly ownerId: string;
  readonly cursorUpdatedAt: string | null;
  readonly cursorTransactionId: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly lastReconciledAt: string | null;
}

export interface MirrorAllocation {
  readonly allocationId: string;
  readonly fundsEffect: string;
  readonly purpose: string;
  readonly amount: string;
  readonly categoryName: string;
  readonly subcategoryName: string | null;
  readonly counterpartyName: string | null;
  readonly note: string | null;
}

export interface MirrorTransaction {
  readonly transactionId: string;
  readonly occurredDate: string;
  readonly occurredTime: string | null;
  readonly amount: string;
  readonly accountFromName: string | null;
  readonly accountToName: string | null;
  readonly merchantName: string | null;
  readonly counterpartyName: string | null;
  readonly note: string | null;
  readonly rawInputSnapshot: string | null;
  readonly status: string;
  readonly confirmedAt: string;
  readonly updatedAt: string;
  readonly allocations: readonly MirrorAllocation[];
}

export interface SyncCursor {
  readonly updatedAt: string;
  readonly transactionId: string;
}

export interface SheetSyncRepository {
  loadSyncState(ownerId: string): Promise<SheetSyncState>;
  saveSyncState(state: SheetSyncState): Promise<void>;

  /**
   * cursor 為 null 代表全表掃描（初次同步與每日校正走這條）。
   * 非 null 時語意是 (updated_at, transaction_id) >= cursor——刻意包含邊界那一列。
   */
  listChangedTransactions(
    ownerId: string,
    cursor: SyncCursor | null,
    limit: number,
  ): Promise<MirrorTransaction[]>;

  /**
   * 「連續失敗需要驚動使用者」這個告警的節流時間戳（ISO 字串），存進 settings 表。
   * 和 `src/telegram/notify-attention.ts` 的 `outbox_last_alert_at` 同一張表、
   * 同一個語意，鍵名是 `sheet_last_alert_at`：只有通知真的送出成功才寫入
   * （見 `sheet-mirror.ts` 的呼叫端），行程重啟也不會被重置——`consecutiveFailures`
   * 本來就是持久的，節流時間戳若只活在記憶體裡，重啟後計數還在門檻之上，
   * 下一次失敗就會立刻再通知一次使用者。
   */
  loadAlertAt(ownerId: string): Promise<string | null>;
  saveAlertAt(ownerId: string, iso: string): Promise<void>;
}
