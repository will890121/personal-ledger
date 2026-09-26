import type { AdvanceRow, RecoveryRow } from "../domain/advance.js";
import type { IncompleteDraft } from "../domain/draft.js";
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

export type AuditAction =
  | "transaction_created"
  | "transaction_updated"
  | "transaction_deleted"
  | "transaction_linked"
  | "transaction_unlinked";

export interface AuditEvent {
  readonly auditEventId: string;
  readonly ownerId: string;
  readonly transactionId: string;
  readonly sourceEventId: string;
  readonly action: AuditAction;
  readonly before: ConfirmedTransaction | null;
  readonly after: ConfirmedTransaction | null;
  readonly createdAt: string;
}

export interface UpdateTransactionCommand {
  readonly ownerId: string;
  readonly transactionId: string;
  readonly sourceEventId: string;
  readonly auditEventId: string;
  readonly expectedUpdatedAt: string;
  readonly replacement: ConfirmedTransaction;
  readonly changedAt: string;
}

export interface DeleteTransactionCommand {
  readonly ownerId: string;
  readonly transactionId: string;
  readonly sourceEventId: string;
  readonly auditEventId: string;
  readonly expectedUpdatedAt: string;
  readonly changedAt: string;
}

export interface LinkTransactionCommand {
  readonly linkId: string;
  readonly ownerId: string;
  readonly fromTransactionId: string;
  readonly toTransactionId: string;
  readonly linkType: "refund_of";
  readonly sourceEventId: string;
  readonly auditEventId: string;
  readonly changedAt: string;
}

export type UnlinkTransactionCommand = LinkTransactionCommand;

export interface BatchInput {
  readonly batchId: string;
  readonly ownerId: string;
  readonly sourceEventId: string;
  readonly itemCount: number;
  readonly createdAt: string;
}

export interface DraftMeta {
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly createdDate?: string;
}

export type DraftSelector =
  | { readonly draftId: string }
  | { readonly ownerId: string; readonly draftRef: string }
  | { readonly previewChatId: string; readonly previewMessageId: string };

export interface DraftRecord {
  readonly draftId: string;
  readonly draftRef: string;
  readonly ownerId: string;
  readonly status: TransactionDraft["status"];
  readonly createdDate: string | null;
  readonly batchId: string | null;
  readonly draft: TransactionDraft | null;
  readonly incomplete: IncompleteDraft | null;
}

export type PendingStatus = "awaiting_input" | "awaiting_confirmation";

export interface PendingQuery {
  readonly ownerId: string;
  readonly status: PendingStatus;
  readonly limit: number;
  readonly offset: number;
}

export interface PendingDraftSummary {
  readonly draftRef: string;
  readonly draftId: string;
  readonly occurredDate: string;
  readonly amount: string | null;
  readonly rawSegment: string;
  readonly createdDate: string | null;
}

export interface LedgerRepository {
  recordInputEvent(input: InputEventInput): Promise<{
    created: boolean;
    eventId: string;
  }>;
  saveBatch(input: BatchInput): Promise<void>;
  saveDraft(draft: TransactionDraft, meta?: DraftMeta): Promise<string>;
  saveIncompleteDraft(draft: IncompleteDraft, meta: DraftMeta): Promise<string>;
  replaceDraft(draftId: string, next: TransactionDraft | IncompleteDraft): Promise<void>;
  getDraftRecord(selector: DraftSelector): Promise<DraftRecord | null>;
  setPreviewMessage(draftId: string, chatId: string, messageId: string): Promise<void>;
  touchDraftDate(draftId: string, date: string): Promise<void>;
  listPendingDrafts(query: PendingQuery): Promise<PendingDraftSummary[]>;
  countPendingDrafts(ownerId: string, status: PendingStatus): Promise<number>;
  archiveDraft(draftId: string): Promise<void>;
  getSetting(ownerId: string, key: string): Promise<string | null>;
  setSetting(ownerId: string, key: string, value: string): Promise<void>;
  clearSetting(ownerId: string, key: string): Promise<void>;
  getDraft(draftId: string): Promise<TransactionDraft | null>;
  confirmDraft(
    draftId: string,
    confirmedAt: string,
    auditEventId: string,
  ): Promise<ConfirmedTransaction>;
  cancelDraft(draftId: string): Promise<TransactionDraft>;
  getTransaction(ownerId: string, transactionId: string): Promise<ConfirmedTransaction | null>;
  updateTransaction(command: UpdateTransactionCommand): Promise<ConfirmedTransaction>;
  softDeleteTransaction(command: DeleteTransactionCommand): Promise<ConfirmedTransaction>;
  linkTransaction(command: LinkTransactionCommand): Promise<void>;
  unlinkTransaction(command: UnlinkTransactionCommand): Promise<void>;
  listAuditEvents(ownerId: string, transactionId: string): Promise<AuditEvent[]>;
  listRecent(ownerId: string, limit: number): Promise<ConfirmedTransaction[]>;
  listAdvanceRows(ownerId: string): Promise<AdvanceRow[]>;
  listRecoveryRows(ownerId: string): Promise<RecoveryRow[]>;
  countRecoveriesForTransaction(ownerId: string, transactionId: string): Promise<number>;
}
