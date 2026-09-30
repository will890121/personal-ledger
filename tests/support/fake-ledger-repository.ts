import type { AdvanceRow, RecoveryRow } from "../../src/domain/advance.js";
import { IncompleteDraftSchema, type IncompleteDraft } from "../../src/domain/draft.js";
import {
  ConfirmedTransactionSchema,
  TransactionDraftSchema,
  type ConfirmedTransaction,
  type TransactionDraft,
} from "../../src/domain/ledger.js";
import type {
  OutboxCause,
  OutboxMessage,
  OutboxPayload,
  OutboxStatus,
} from "../../src/domain/outbox.js";
import type {
  AuditEvent,
  BatchInput,
  DeleteTransactionCommand,
  DraftMeta,
  DraftRecord,
  DraftSelector,
  InputEventInput,
  LedgerRepository,
  OutboxRequest,
  OutboxSummary,
  PendingDraftSummary,
  PendingQuery,
  PendingStatus,
  UpdateTransactionCommand,
} from "../../src/ports/ledger-repository.js";

// 內部可變版本：OutboxMessage 對外是 readonly 的投影，lease/created 是 DB 專屬的排程
// 記帳，不屬於公開型別，所以額外多帶這兩個欄位。與 SqliteLedgerRepository 對齊：
// lease 未過期就擋住重新取得、失敗要清空 lease 並 attempts+1、重試要把 attempts 歸零。
interface FakeOutboxMessage {
  messageId: string;
  ownerId: string;
  cause: OutboxCause;
  chatId: string;
  targetMessageId?: string;
  text: string;
  replyMarkup?: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  lastError?: string;
  // 對應 SQLite 版的 created_at：訊息何時被排進佇列，summarizeOutbox 的 oldestPendingAt
  // 與 stuck 清單排序都要用這個欄位，不是 nextAttemptAt——理由見
  // SqliteLedgerRepository.summarizeOutbox 的註解。
  createdAt: string;
  sequence: number;
  deliveredAt: string | null;
}

function toOutboxMessage(row: FakeOutboxMessage): OutboxMessage {
  return {
    messageId: row.messageId,
    ownerId: row.ownerId,
    cause: row.cause,
    chatId: row.chatId,
    ...(row.targetMessageId ? { targetMessageId: row.targetMessageId } : {}),
    text: row.text,
    ...(row.replyMarkup ? { replyMarkup: row.replyMarkup } : {}),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    ...(row.lastError ? { lastError: row.lastError } : {}),
  };
}

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
  public readonly outboxMessages = new Map<string, FakeOutboxMessage>();
  private refCounter = 0;
  private sequence = 0;
  private outboxSequence = 0;

  /** 測試用種子方法，對應 SQLite 版測試直接 INSERT INTO outbox_messages 的做法。 */
  public seedOutboxMessage(input: {
    messageId: string;
    ownerId: string;
    cause: OutboxCause;
    chatId: string;
    targetMessageId?: string;
    text: string;
    replyMarkup?: string;
    nextAttemptAt: string;
    attempts?: number;
    // 預設等於 nextAttemptAt，與 SQLite 版測試的 seed() 相同約定；需要「已退避、
    // next_attempt_at 被推到未來」的情境時才明確傳入更早的值。
    createdAt?: string;
  }): void {
    this.outboxSequence += 1;
    this.outboxMessages.set(input.messageId, {
      messageId: input.messageId,
      ownerId: input.ownerId,
      cause: input.cause,
      chatId: input.chatId,
      ...(input.targetMessageId ? { targetMessageId: input.targetMessageId } : {}),
      text: input.text,
      ...(input.replyMarkup ? { replyMarkup: input.replyMarkup } : {}),
      status: "pending",
      attempts: input.attempts ?? 0,
      nextAttemptAt: input.nextAttemptAt,
      leaseExpiresAt: null,
      createdAt: input.createdAt ?? input.nextAttemptAt,
      sequence: this.outboxSequence,
      deliveredAt: null,
    });
  }

  public claimDueOutbox(
    ownerId: string,
    now: string,
    leaseUntil: string,
    limit: number,
  ): Promise<OutboxMessage[]> {
    const due = [...this.outboxMessages.values()]
      .filter(
        (row) =>
          row.ownerId === ownerId &&
          row.status === "pending" &&
          row.nextAttemptAt <= now &&
          // lease 未過期就擋住重新取得，語意須與 SqliteLedgerRepository 一致。
          (row.leaseExpiresAt === null || row.leaseExpiresAt <= now),
      )
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, limit);
    for (const row of due) row.leaseExpiresAt = leaseUntil;
    return Promise.resolve(due.map((row) => toOutboxMessage(row)));
  }

  // 樂觀鎖，語意必須與 SqliteLedgerRepository 的 `lease_expires_at IS ?` 逐字對齊：
  // 只有 leaseExpiresAt 仍等於 claim 當下寫入的那個值時才寫得進去，null 是一個
  // 真正的版本值（「沒有人租走這一列」），不是「不檢查」。
  private casOutbox(messageId: string, leaseToken: string | null): FakeOutboxMessage | undefined {
    const row = this.outboxMessages.get(messageId);
    if (!row || row.leaseExpiresAt !== leaseToken) return undefined;
    return row;
  }

  public markOutboxDelivered(
    messageId: string,
    deliveredAt: string,
    leaseToken: string | null,
  ): Promise<boolean> {
    const row = this.casOutbox(messageId, leaseToken);
    if (!row) return Promise.resolve(false);
    row.status = "delivered";
    row.deliveredAt = deliveredAt;
    row.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public markOutboxFailed(
    messageId: string,
    nextAttemptAt: string,
    lastError: string,
    leaseToken: string | null,
  ): Promise<boolean> {
    const row = this.casOutbox(messageId, leaseToken);
    if (!row) return Promise.resolve(false);
    // lease 必須一起釋放，否則下一次重試要等到 lease 自然過期。
    row.attempts += 1;
    row.nextAttemptAt = nextAttemptAt;
    row.lastError = lastError;
    row.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public markOutboxNeedsAttention(
    messageId: string,
    lastError: string,
    leaseToken: string | null,
  ): Promise<boolean> {
    const row = this.casOutbox(messageId, leaseToken);
    if (!row) return Promise.resolve(false);
    row.status = "needs_attention";
    row.lastError = lastError;
    row.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public retryOutboxNeedsAttention(ownerId: string, nextAttemptAt: string): Promise<number> {
    let changed = 0;
    for (const row of this.outboxMessages.values()) {
      if (row.ownerId !== ownerId || row.status !== "needs_attention") continue;
      row.status = "pending";
      row.attempts = 0;
      row.nextAttemptAt = nextAttemptAt;
      row.leaseExpiresAt = null;
      changed += 1;
    }
    return Promise.resolve(changed);
  }

  public summarizeOutbox(ownerId: string): Promise<OutboxSummary> {
    const owned = [...this.outboxMessages.values()].filter((row) => row.ownerId === ownerId);
    const pending = owned.filter((row) => row.status === "pending");
    const needsAttention = owned.filter((row) => row.status === "needs_attention");
    const delivered = owned.filter((row) => row.deliveredAt !== null);
    // 用 createdAt（排進佇列的時間），不是 nextAttemptAt（下一次到期時間）：
    // 已經失敗過的訊息 nextAttemptAt 會因退避被推到未來，拿它當「最舊」會讓 /status
    // 顯示負的等待分鐘數，見 SqliteLedgerRepository.summarizeOutbox 的同一段說明。
    const oldestPendingAt = pending.reduce<string | null>(
      (oldest, row) => (oldest === null || row.createdAt < oldest ? row.createdAt : oldest),
      null,
    );
    const lastDeliveredAt = delivered.reduce<string | null>(
      (latest, row) =>
        row.deliveredAt !== null && (latest === null || row.deliveredAt > latest)
          ? row.deliveredAt
          : latest,
      null,
    );
    const stuck = needsAttention
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence,
      )
      .slice(0, 5)
      .map((row) => toOutboxMessage(row));
    return Promise.resolve({
      pending: pending.length,
      needsAttention: needsAttention.length,
      oldestPendingAt,
      lastDeliveredAt,
      stuck,
    });
  }

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
    outbox: OutboxRequest<ConfirmedTransaction>,
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
      // 重複確認：outbox 已經有一列了，這裡不推。
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
    this.enqueueOutbox(
      outbox.messageId,
      draft.ownerId,
      outbox.cause,
      outbox.render(transaction),
      confirmedAt,
    );
    return Promise.resolve(transaction);
  }

  /** 與 SqliteLedgerRepository.enqueueOutbox 對齊：只在帳本變更成功時呼叫。 */
  private enqueueOutbox(
    messageId: string,
    ownerId: string,
    cause: OutboxCause,
    payload: OutboxPayload,
    now: string,
  ): void {
    this.outboxSequence += 1;
    this.outboxMessages.set(messageId, {
      messageId,
      ownerId,
      cause,
      chatId: payload.chatId,
      ...(payload.targetMessageId ? { targetMessageId: payload.targetMessageId } : {}),
      text: payload.text,
      ...(payload.replyMarkup ? { replyMarkup: payload.replyMarkup } : {}),
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      leaseExpiresAt: null,
      createdAt: now,
      sequence: this.outboxSequence,
      deliveredAt: null,
    });
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

  public updateTransaction(
    command: UpdateTransactionCommand,
    outbox: OutboxRequest<ConfirmedTransaction>,
  ): Promise<ConfirmedTransaction> {
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
    this.enqueueOutbox(
      outbox.messageId,
      command.ownerId,
      outbox.cause,
      outbox.render(updated),
      command.changedAt,
    );
    return Promise.resolve(updated);
  }

  public softDeleteTransaction(
    command: DeleteTransactionCommand,
    outbox: OutboxRequest<ConfirmedTransaction>,
  ): Promise<ConfirmedTransaction> {
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
      this.enqueueOutbox(
        outbox.messageId,
        command.ownerId,
        outbox.cause,
        outbox.render(deleted),
        command.changedAt,
      );
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
        if (allocation.recoversAllocationId && allocationIds.has(allocation.recoversAllocationId)) {
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
