export interface SheetSyncState {
  readonly ownerId: string;
  readonly cursorUpdatedAt: string | null;
  readonly cursorTransactionId: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly lastReconciledAt: string | null;
}

export interface SheetSyncRepository {
  loadSyncState(ownerId: string): Promise<SheetSyncState>;
  saveSyncState(state: SheetSyncState): Promise<void>;
}
