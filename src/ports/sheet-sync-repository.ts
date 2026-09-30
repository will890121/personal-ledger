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
}
