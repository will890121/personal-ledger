import type { ConfirmedTransaction, TransactionDraft } from "../domain/ledger.js";

export interface InputEventInput {
  readonly eventId: string;
  readonly ownerId: string;
  readonly telegramUpdateId: string;
  readonly sourceType: "telegram";
  readonly sourceRef: string;
  readonly rawText: string;
  readonly receivedAt: string;
}

export interface LedgerRepository {
  recordInputEvent(input: InputEventInput): Promise<{
    created: boolean;
    eventId: string;
  }>;
  saveDraft(draft: TransactionDraft): Promise<void>;
  getDraft(draftId: string): Promise<TransactionDraft | null>;
  confirmDraft(draftId: string, confirmedAt: string): Promise<ConfirmedTransaction>;
  cancelDraft(draftId: string): Promise<TransactionDraft>;
  listRecent(ownerId: string, limit: number): Promise<ConfirmedTransaction[]>;
}
