import type { AdvanceRow, RecoveryRow } from "../../src/domain/advance.js";
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
  // 依插入順序保存稽核事件，供 listAuditEvents 依 ownerId/transactionId 過濾後回傳。
  public readonly auditEvents: AuditEvent[] = [];
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

  public readonly settings = new Map<string, string>();

  public getSetting(ownerId: string, key: string): Promise<string | null> {
    return Promise.resolve(this.settings.get(`${ownerId}:${key}`) ?? null);
  }

  public setSetting(ownerId: string, key: string, value: string): Promise<void> {
    this.settings.set(`${ownerId}:${key}`, value);
    return Promise.resolve();
  }

  public clearSetting(ownerId: string, key: string): Promise<void> {
    this.settings.delete(`${ownerId}:${key}`);
    return Promise.resolve();
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
    const before = current[1];
    // 與 SqliteLedgerRepository 一致的樂觀鎖：before.updatedAt 若缺席則退回 confirmedAt。
    if ((before.updatedAt ?? before.confirmedAt) !== command.expectedUpdatedAt) {
      return Promise.reject(new Error("stale transaction update"));
    }
    const updated = ConfirmedTransactionSchema.parse({
      ...command.replacement,
      updatedAt: command.changedAt,
    });
    this.transactions.set(current[0], updated);
    this.auditEvents.push({
      auditEventId: command.auditEventId,
      ownerId: command.ownerId,
      transactionId: command.transactionId,
      sourceEventId: command.sourceEventId,
      action: "transaction_updated",
      before,
      after: updated,
      createdAt: command.changedAt,
    });
    return Promise.resolve(updated);
  }

  public softDeleteTransaction(command: DeleteTransactionCommand): Promise<ConfirmedTransaction> {
    return this.getTransaction(command.ownerId, command.transactionId).then((current) => {
      if (!current) throw new Error("transaction not found for owner");
      if ((current.updatedAt ?? current.confirmedAt) !== command.expectedUpdatedAt) {
        throw new Error("stale transaction update");
      }
      if (this.countRecoveries(command.transactionId) > 0) {
        throw new Error("advance still has recoveries");
      }
      const deleted = ConfirmedTransactionSchema.parse({
        ...current,
        status: "deleted",
        updatedAt: command.changedAt,
        deletedAt: command.changedAt,
      });
      this.transactions.set(current.requestId, deleted);
      this.auditEvents.push({
        auditEventId: command.auditEventId,
        ownerId: command.ownerId,
        transactionId: command.transactionId,
        sourceEventId: command.sourceEventId,
        action: "transaction_deleted",
        before: current,
        after: deleted,
        createdAt: command.changedAt,
      });
      return deleted;
    });
  }

  // 掃描已確認交易，計算有多少筆回收配置指向某交易的任一配置。
  // 與 SqliteLedgerRepository 的刪除保護語意一致：不限定 owner，只看回收交易是否 confirmed。
  private countRecoveries(transactionId: string, ownerId?: string): number {
    const allocationIds = new Set<string>();
    for (const transaction of this.transactions.values()) {
      if (transaction.transactionId !== transactionId) continue;
      for (const allocation of transaction.allocations) allocationIds.add(allocation.allocationId);
    }
    let total = 0;
    for (const transaction of this.transactions.values()) {
      if (transaction.status !== "confirmed") continue;
      if (ownerId !== undefined && transaction.ownerId !== ownerId) continue;
      for (const allocation of transaction.allocations) {
        if (
          allocation.recoversAllocationId &&
          allocationIds.has(allocation.recoversAllocationId)
        ) {
          total += 1;
        }
      }
    }
    return total;
  }

  public listAdvanceRows(ownerId: string): Promise<AdvanceRow[]> {
    const rows: AdvanceRow[] = [];
    for (const transaction of this.transactions.values()) {
      if (transaction.ownerId !== ownerId || transaction.status !== "confirmed") continue;
      for (const allocation of transaction.allocations) {
        if (allocation.purpose !== "advance") continue;
        rows.push({
          allocationId: allocation.allocationId,
          transactionId: transaction.transactionId,
          occurredDate: transaction.occurredDate,
          counterpartyId: allocation.counterpartyId ?? "",
          ...(allocation.categoryId ? { categoryId: allocation.categoryId } : {}),
          category: allocation.category,
          ...(allocation.subcategory ? { subcategory: allocation.subcategory } : {}),
          amount: allocation.amount.amount,
        });
      }
    }
    rows.sort(
      (left, right) =>
        left.occurredDate.localeCompare(right.occurredDate) ||
        left.allocationId.localeCompare(right.allocationId),
    );
    return Promise.resolve(rows);
  }

  public listRecoveryRows(ownerId: string): Promise<RecoveryRow[]> {
    const rows: RecoveryRow[] = [];
    for (const transaction of this.transactions.values()) {
      if (transaction.ownerId !== ownerId || transaction.status !== "confirmed") continue;
      for (const allocation of transaction.allocations) {
        if (allocation.purpose !== "advance_recovery" || !allocation.recoversAllocationId) {
          continue;
        }
        rows.push({
          recoversAllocationId: allocation.recoversAllocationId,
          amount: allocation.amount.amount,
        });
      }
    }
    return Promise.resolve(rows);
  }

  public countRecoveriesForTransaction(ownerId: string, transactionId: string): Promise<number> {
    return Promise.resolve(this.countRecoveries(transactionId, ownerId));
  }

  public linkTransaction(): Promise<void> {
    return Promise.resolve();
  }
  public unlinkTransaction(): Promise<void> {
    return Promise.resolve();
  }
  public listAuditEvents(ownerId: string, transactionId: string): Promise<AuditEvent[]> {
    return Promise.resolve(
      this.auditEvents.filter(
        (event) => event.ownerId === ownerId && event.transactionId === transactionId,
      ),
    );
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
