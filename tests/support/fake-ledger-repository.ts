import { IncompleteDraftSchema, type IncompleteDraft } from "../../src/domain/draft.js";
import {
  ConfirmedTransactionSchema,
  TransactionDraftSchema,
  type ConfirmedTransaction,
  type TransactionDraft,
} from "../../src/domain/ledger.js";
import type {
  AuditEvent,
  BatchInput,
  DeleteTransactionCommand,
  DraftMeta,
  DraftRecord,
  DraftSelector,
  InputEventInput,
  LedgerRepository,
  PendingDraftSummary,
  PendingQuery,
  PendingStatus,
  UpdateTransactionCommand,
} from "../../src/ports/ledger-repository.js";

interface FakeDraftRecord {
  draftId: string;
  draftRef: string;
  ownerId: string;
  status: TransactionDraft["status"];
  createdDate: string | null;
  batchId: string | null;
  previewChatId: string | null;
  previewMessageId: string | null;
  sequence: number;
}

export class FakeLedgerRepository implements LedgerRepository {
  public readonly inputEvents = new Map<string, InputEventInput>();
  public readonly drafts = new Map<string, TransactionDraft>();
  public readonly incompleteDrafts = new Map<string, IncompleteDraft>();
  public readonly records = new Map<string, FakeDraftRecord>();
  public readonly batches = new Map<string, BatchInput>();
  public readonly transactions = new Map<string, ConfirmedTransaction>();
  private refCounter = 0;
  private sequence = 0;

  private nextDraftRef(): string {
    this.refCounter += 1;
    return this.refCounter.toString(16).padStart(8, "0");
  }

  private track(
    draftId: string,
    ownerId: string,
    status: TransactionDraft["status"],
    meta: DraftMeta,
  ): string {
    const existing = this.records.get(draftId);
    const draftRef = existing?.draftRef ?? this.nextDraftRef();
    this.sequence += 1;
    this.records.set(draftId, {
      draftId,
      draftRef,
      ownerId,
      status,
      createdDate: meta.createdDate ?? existing?.createdDate ?? null,
      batchId: meta.batchId ?? existing?.batchId ?? null,
      previewChatId: existing?.previewChatId ?? null,
      previewMessageId: existing?.previewMessageId ?? null,
      sequence: existing?.sequence ?? this.sequence,
    });
    return draftRef;
  }

  public saveBatch(input: BatchInput): Promise<void> {
    this.batches.set(input.batchId, input);
    return Promise.resolve();
  }

  public saveIncompleteDraft(draft: IncompleteDraft, meta: DraftMeta): Promise<string> {
    const value = IncompleteDraftSchema.parse(draft);
    this.incompleteDrafts.set(value.draftId, value);
    return Promise.resolve(this.track(value.draftId, value.ownerId, "awaiting_input", meta));
  }

  public replaceDraft(draftId: string, next: TransactionDraft | IncompleteDraft): Promise<void> {
    if (next.status === "awaiting_input") {
      const value = IncompleteDraftSchema.parse(next);
      this.incompleteDrafts.set(draftId, value);
      this.drafts.delete(draftId);
      this.track(draftId, value.ownerId, "awaiting_input", {});
      return Promise.resolve();
    }
    const value = TransactionDraftSchema.parse(next);
    this.drafts.set(draftId, value);
    this.incompleteDrafts.delete(draftId);
    this.track(draftId, value.ownerId, value.status, {});
    return Promise.resolve();
  }

  public getDraftRecord(selector: DraftSelector): Promise<DraftRecord | null> {
    const record = [...this.records.values()].find((item) => {
      if ("draftId" in selector) return item.draftId === selector.draftId;
      if ("draftRef" in selector)
        return item.ownerId === selector.ownerId && item.draftRef === selector.draftRef;
      return (
        item.previewChatId === selector.previewChatId &&
        item.previewMessageId === selector.previewMessageId
      );
    });
    if (!record) return Promise.resolve(null);
    return Promise.resolve({
      draftId: record.draftId,
      draftRef: record.draftRef,
      ownerId: record.ownerId,
      status: record.status,
      createdDate: record.createdDate,
      batchId: record.batchId,
      draft: this.drafts.get(record.draftId) ?? null,
      incomplete: this.incompleteDrafts.get(record.draftId) ?? null,
    });
  }

  public setPreviewMessage(draftId: string, chatId: string, messageId: string): Promise<void> {
    const record = this.records.get(draftId);
    if (record) {
      record.previewChatId = chatId;
      record.previewMessageId = messageId;
    }
    return Promise.resolve();
  }

  public touchDraftDate(draftId: string, date: string): Promise<void> {
    const record = this.records.get(draftId);
    if (record) record.createdDate = date;
    return Promise.resolve();
  }

  public archiveDraft(draftId: string): Promise<void> {
    const record = this.records.get(draftId);
    if (record) record.status = "archived";
    return Promise.resolve();
  }

  public listPendingDrafts(query: PendingQuery): Promise<PendingDraftSummary[]> {
    const items = [...this.records.values()]
      .filter((record) => record.ownerId === query.ownerId && record.status === query.status)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(query.offset, query.offset + query.limit)
      .map((record) => {
        const complete = this.drafts.get(record.draftId);
        const incomplete = this.incompleteDrafts.get(record.draftId);
        return {
          draftId: record.draftId,
          draftRef: record.draftRef,
          occurredDate: complete?.occurredDate ?? incomplete?.partial.occurredDate ?? "",
          amount: complete?.amount.amount ?? null,
          rawSegment: incomplete?.partial.rawSegment ?? complete?.rawInputSnapshot ?? "",
          createdDate: record.createdDate,
        };
      });
    return Promise.resolve(items);
  }

  public countPendingDrafts(ownerId: string, status: PendingStatus): Promise<number> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.ownerId === ownerId && record.status === status,
      ).length,
    );
  }

  public recordInputEvent(input: InputEventInput): Promise<{ created: boolean; eventId: string }> {
    const existing = this.inputEvents.get(input.telegramUpdateId);
    if (existing) {
      return Promise.resolve({ created: false, eventId: existing.eventId });
    }
    this.inputEvents.set(input.telegramUpdateId, input);
    return Promise.resolve({ created: true, eventId: input.eventId });
  }

  public saveDraft(draft: TransactionDraft, meta: DraftMeta = {}): Promise<string> {
    const value = TransactionDraftSchema.parse(draft);
    this.drafts.set(value.draftId, value);
    return Promise.resolve(this.track(value.draftId, value.ownerId, value.status, meta));
  }

  public getDraft(draftId: string): Promise<TransactionDraft | null> {
    return Promise.resolve(this.drafts.get(draftId) ?? null);
  }

  public confirmDraft(
    draftId: string,
    confirmedAt: string,
    auditEventId: string,
  ): Promise<ConfirmedTransaction> {
    if (!auditEventId) {
      return Promise.reject(new Error("audit event id is required"));
    }
    const draft = this.drafts.get(draftId);
    if (!draft) {
      return Promise.reject(new Error("draft not found"));
    }
    const existing = this.transactions.get(draft.requestId);
    if (existing) {
      return Promise.resolve(existing);
    }
    if (draft.status === "cancelled") {
      return Promise.reject(new Error("cancelled draft cannot be confirmed"));
    }

    const transaction = ConfirmedTransactionSchema.parse({
      ...draft,
      transactionId: `transaction-${draft.draftId}`,
      confirmedAt,
      status: "confirmed",
    });
    this.transactions.set(draft.requestId, transaction);
    this.drafts.set(draftId, { ...draft, status: "confirmed" });
    const record = this.records.get(draftId);
    if (record) record.status = "confirmed";
    return Promise.resolve(transaction);
  }

  public getTransaction(
    ownerId: string,
    transactionId: string,
  ): Promise<ConfirmedTransaction | null> {
    return Promise.resolve(
      [...this.transactions.values()].find(
        (item) => item.ownerId === ownerId && item.transactionId === transactionId,
      ) ?? null,
    );
  }

  public updateTransaction(command: UpdateTransactionCommand): Promise<ConfirmedTransaction> {
    const current = [...this.transactions.entries()].find(
      ([, item]) =>
        item.ownerId === command.ownerId && item.transactionId === command.transactionId,
    );
    if (!current) return Promise.reject(new Error("transaction not found for owner"));
    const updated = ConfirmedTransactionSchema.parse({
      ...command.replacement,
      updatedAt: command.changedAt,
    });
    this.transactions.set(current[0], updated);
    return Promise.resolve(updated);
  }

  public softDeleteTransaction(command: DeleteTransactionCommand): Promise<ConfirmedTransaction> {
    return this.getTransaction(command.ownerId, command.transactionId).then((current) => {
      if (!current) throw new Error("transaction not found for owner");
      const deleted = ConfirmedTransactionSchema.parse({
        ...current,
        status: "deleted",
        updatedAt: command.changedAt,
        deletedAt: command.changedAt,
      });
      this.transactions.set(current.requestId, deleted);
      return deleted;
    });
  }

  public linkTransaction(): Promise<void> {
    return Promise.resolve();
  }
  public unlinkTransaction(): Promise<void> {
    return Promise.resolve();
  }
  public listAuditEvents(): Promise<AuditEvent[]> {
    return Promise.resolve([]);
  }

  public cancelDraft(draftId: string): Promise<TransactionDraft> {
    const draft = this.drafts.get(draftId);
    if (!draft) {
      return Promise.reject(new Error("draft not found"));
    }
    if (draft.status === "confirmed") {
      return Promise.reject(new Error("confirmed draft cannot be cancelled"));
    }
    const cancelled = TransactionDraftSchema.parse({ ...draft, status: "cancelled" });
    this.drafts.set(draftId, cancelled);
    const record = this.records.get(draftId);
    if (record) record.status = "cancelled";
    return Promise.resolve(cancelled);
  }

  public listRecent(ownerId: string, limit: number): Promise<ConfirmedTransaction[]> {
    return Promise.resolve(
      [...this.transactions.values()]
        .filter(
          (transaction) => transaction.ownerId === ownerId && transaction.status === "confirmed",
        )
        .sort((left, right) => right.confirmedAt.localeCompare(left.confirmedAt))
        .slice(0, limit),
    );
  }
}
