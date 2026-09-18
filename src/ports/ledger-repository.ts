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

export interface LedgerRepository {
  recordInputEvent(input: InputEventInput): Promise<{
    created: boolean;
    eventId: string;
  }>;
  saveDraft(draft: TransactionDraft): Promise<void>;
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
}
