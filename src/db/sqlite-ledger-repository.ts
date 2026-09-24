import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { IncompleteDraftSchema, type IncompleteDraft } from "../domain/draft.js";
import {
  ConfirmedTransactionSchema,
  TransactionDraftSchema,
  type Allocation,
  type ConfirmedTransaction,
  type TransactionDraft,
} from "../domain/ledger.js";
import type {
  AuditAction,
  AuditEvent,
  BatchInput,
  DeleteTransactionCommand,
  DraftMeta,
  DraftRecord,
  DraftSelector,
  InputEventInput,
  LedgerRepository,
  LinkTransactionCommand,
  PendingDraftSummary,
  PendingQuery,
  PendingStatus,
  UnlinkTransactionCommand,
  UpdateTransactionCommand,
} from "../ports/ledger-repository.js";

interface DraftRow {
  draft_json: string;
}
interface DraftRecordRow {
  draft_id: string;
  draft_ref: string;
  owner_id: string;
  status: string;
  created_date: string | null;
  batch_id: string | null;
  draft_json: string;
}
interface PendingRow {
  draft_id: string;
  draft_ref: string;
  occurred_date: string;
  amount: string | null;
  draft_json: string;
  created_date: string | null;
}
interface EventRow {
  event_id: string;
  source_type: string;
  source_ref: string;
  raw_text: string;
}
interface TransactionRow {
  transaction_id: string;
  draft_id: string;
  owner_id: string;
  request_id: string;
  source_event_id: string;
  source_type: "telegram" | "system";
  source_ref: string;
  occurred_date: string;
  occurred_time: string | null;
  amount: string;
  currency: "TWD";
  account_from_id: string | null;
  account_to_id: string | null;
  merchant_id: string | null;
  counterparty_id: string | null;
  note: string | null;
  raw_input_snapshot: string | null;
  status: "confirmed" | "deleted";
  confirmed_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
interface AllocationRow {
  allocation_id: string;
  funds_effect: Allocation["fundsEffect"];
  purpose: Allocation["purpose"];
  amount: string;
  currency: "TWD";
  category_id: string;
  category_snapshot: string;
  subcategory_snapshot: string | null;
  counterparty_id: string | null;
  note: string | null;
  recovers_allocation_id: string | null;
}
interface AuditRow {
  audit_event_id: string;
  owner_id: string;
  transaction_id: string;
  source_event_id: string;
  action: AuditAction;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export class SqliteLedgerRepository implements LedgerRepository {
  public constructor(private readonly database: Database.Database) {}

  public recordInputEvent(input: InputEventInput): Promise<{ created: boolean; eventId: string }> {
    const result = this.database
      .prepare(
        `INSERT INTO input_events (event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (telegram_update_id) DO NOTHING`,
      )
      .run(
        input.eventId,
        input.ownerId,
        input.telegramUpdateId,
        input.sourceType,
        input.sourceRef,
        input.rawText,
        input.receivedAt,
      );
    if (result.changes === 1) return Promise.resolve({ created: true, eventId: input.eventId });
    const existing = this.database
      .prepare("SELECT event_id FROM input_events WHERE telegram_update_id = ?")
      .get(input.telegramUpdateId) as EventRow | undefined;
    if (!existing) throw new Error("duplicate input event could not be loaded");
    return Promise.resolve({ created: false, eventId: existing.event_id });
  }

  public saveBatch(input: BatchInput): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO batches (batch_id, owner_id, source_event_id, item_count, created_at)
      VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.batchId, input.ownerId, input.sourceEventId, input.itemCount, input.createdAt);
    return Promise.resolve();
  }

  public saveDraft(draft: TransactionDraft, meta: DraftMeta = {}): Promise<string> {
    const value = TransactionDraftSchema.parse(draft);
    const draftRef = this.generateDraftRef(value.ownerId);
    this.database
      .prepare(
        `INSERT INTO drafts (draft_id, draft_ref, owner_id, request_id, source_event_id, batch_id, batch_index, occurred_date, amount, currency, status, draft_json, created_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.draftId,
        draftRef,
        value.ownerId,
        value.requestId,
        value.sourceEventId,
        meta.batchId ?? null,
        meta.batchIndex ?? null,
        value.occurredDate,
        value.amount.amount,
        value.amount.currency,
        value.status,
        JSON.stringify(value),
        meta.createdDate ?? null,
      );
    return Promise.resolve(draftRef);
  }

  public saveIncompleteDraft(draft: IncompleteDraft, meta: DraftMeta): Promise<string> {
    const value = IncompleteDraftSchema.parse(draft);
    const draftRef = this.generateDraftRef(value.ownerId);
    this.database
      .prepare(
        `INSERT INTO drafts (draft_id, draft_ref, owner_id, request_id, source_event_id, batch_id, batch_index, occurred_date, amount, currency, status, pending_fields, draft_json, created_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'awaiting_input', ?, ?, ?)`,
      )
      .run(
        value.draftId,
        draftRef,
        value.ownerId,
        value.requestId,
        value.sourceEventId,
        meta.batchId ?? value.batchId,
        meta.batchIndex ?? value.batchIndex,
        value.partial.occurredDate,
        JSON.stringify(value.pendingFields),
        JSON.stringify(value),
        meta.createdDate ?? null,
      );
    return Promise.resolve(draftRef);
  }

  public replaceDraft(draftId: string, next: TransactionDraft | IncompleteDraft): Promise<void> {
    if (next.status === "awaiting_input") {
      const value = IncompleteDraftSchema.parse(next);
      this.database
        .prepare(
          `UPDATE drafts
        SET status = 'awaiting_input', amount = NULL, currency = NULL, occurred_date = ?, pending_fields = ?, draft_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE draft_id = ?`,
        )
        .run(
          value.partial.occurredDate,
          JSON.stringify(value.pendingFields),
          JSON.stringify(value),
          draftId,
        );
      return Promise.resolve();
    }

    const value = TransactionDraftSchema.parse(next);
    this.database
      .prepare(
        `UPDATE drafts
      SET status = ?, amount = ?, currency = ?, occurred_date = ?, pending_fields = NULL, draft_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ?`,
      )
      .run(
        value.status,
        value.amount.amount,
        value.amount.currency,
        value.occurredDate,
        JSON.stringify(value),
        draftId,
      );
    return Promise.resolve();
  }

  public getDraftRecord(selector: DraftSelector): Promise<DraftRecord | null> {
    const query =
      "draftId" in selector
        ? { where: "draft_id = ?", args: [selector.draftId] }
        : "draftRef" in selector
          ? {
              where: "owner_id = ? AND draft_ref = ?",
              args: [selector.ownerId, selector.draftRef],
            }
          : {
              where: "preview_chat_id = ? AND preview_message_id = ?",
              args: [selector.previewChatId, selector.previewMessageId],
            };
    const row = this.database
      .prepare(
        `SELECT draft_id, draft_ref, owner_id, status, created_date, batch_id, draft_json
       FROM drafts WHERE ${query.where}`,
      )
      .get(...query.args) as DraftRecordRow | undefined;
    if (!row) return Promise.resolve(null);

    const parsed: unknown = JSON.parse(row.draft_json);
    // 以草稿 JSON 自身的狀態判斷型別，而非資料列狀態：封存或取消會改變資料列狀態，
    // 但不會改寫草稿內容，兩者必須分開看待。
    const isIncomplete =
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { status?: string }).status === "awaiting_input";
    return Promise.resolve({
      draftId: row.draft_id,
      draftRef: row.draft_ref,
      ownerId: row.owner_id,
      status: row.status as TransactionDraft["status"],
      createdDate: row.created_date,
      batchId: row.batch_id,
      draft: isIncomplete ? null : TransactionDraftSchema.parse(parsed),
      incomplete: isIncomplete ? IncompleteDraftSchema.parse(parsed) : null,
    });
  }

  public setPreviewMessage(draftId: string, chatId: string, messageId: string): Promise<void> {
    this.database
      .prepare("UPDATE drafts SET preview_chat_id = ?, preview_message_id = ? WHERE draft_id = ?")
      .run(chatId, messageId, draftId);
    return Promise.resolve();
  }

  public touchDraftDate(draftId: string, date: string): Promise<void> {
    this.database
      .prepare(
        "UPDATE drafts SET created_date = ?, updated_at = CURRENT_TIMESTAMP WHERE draft_id = ?",
      )
      .run(date, draftId);
    return Promise.resolve();
  }

  public archiveDraft(draftId: string): Promise<void> {
    this.database
      .prepare(
        "UPDATE drafts SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE draft_id = ?",
      )
      .run(draftId);
    return Promise.resolve();
  }

  public listPendingDrafts(query: PendingQuery): Promise<PendingDraftSummary[]> {
    const rows = this.database
      .prepare(
        `SELECT draft_id, draft_ref, occurred_date, amount, draft_json, created_date
       FROM drafts
       WHERE owner_id = ? AND status = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
      )
      .all(query.ownerId, query.status, query.limit, query.offset) as PendingRow[];
    return Promise.resolve(rows.map((row) => toPendingSummary(row)));
  }

  public countPendingDrafts(ownerId: string, status: PendingStatus): Promise<number> {
    const row = this.database
      .prepare("SELECT count(*) AS total FROM drafts WHERE owner_id = ? AND status = ?")
      .get(ownerId, status) as { total: number };
    return Promise.resolve(row.total);
  }

  public getSetting(ownerId: string, key: string): Promise<string | null> {
    const row = this.database
      .prepare("SELECT value FROM settings WHERE owner_id = ? AND key = ?")
      .get(ownerId, key) as { value: string } | undefined;
    return Promise.resolve(row?.value ?? null);
  }

  public setSetting(ownerId: string, key: string, value: string): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO settings (owner_id, key, value, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (owner_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(ownerId, key, value);
    return Promise.resolve();
  }

  public clearSetting(ownerId: string, key: string): Promise<void> {
    this.database.prepare("DELETE FROM settings WHERE owner_id = ? AND key = ?").run(ownerId, key);
    return Promise.resolve();
  }

  private generateDraftRef(ownerId: string): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = randomBytes(4).toString("hex");
      const clash = this.database
        .prepare("SELECT 1 FROM drafts WHERE owner_id = ? AND draft_ref = ?")
        .get(ownerId, candidate);
      if (!clash) return candidate;
    }
    throw new Error("unable to allocate draft reference");
  }

  public getDraft(draftId: string): Promise<TransactionDraft | null> {
    return Promise.resolve(this.getDraftSync(draftId));
  }

  public confirmDraft(
    draftId: string,
    confirmedAt: string,
    auditEventId: string,
  ): Promise<ConfirmedTransaction> {
    const execute = this.database.transaction(() => {
      const draft = this.getDraftSync(draftId);
      if (!draft) throw new Error("draft not found");
      const existing = this.getByRequestId(draft.requestId);
      if (existing) return existing;
      if (draft.status === "cancelled") throw new Error("cancelled draft cannot be confirmed");
      const source = this.database
        .prepare(
          "SELECT event_id, source_type, source_ref, raw_text FROM input_events WHERE event_id = ?",
        )
        .get(draft.sourceEventId) as EventRow | undefined;
      if (!source) throw new Error("source event not found");
      const transactionId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO transactions (transaction_id, draft_id, owner_id, request_id, source_event_id, source_type, source_ref, occurred_date, occurred_time, amount, currency, account_from_id, account_to_id, merchant_id, counterparty_id, note, raw_input_snapshot, status, confirmed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
        )
        .run(
          transactionId,
          draft.draftId,
          draft.ownerId,
          draft.requestId,
          draft.sourceEventId,
          source.source_type,
          source.source_ref,
          draft.occurredDate,
          draft.occurredTime ?? null,
          draft.amount.amount,
          draft.amount.currency,
          draft.accountFromId ?? null,
          draft.accountToId ?? null,
          draft.merchantId ?? null,
          draft.counterpartyId ?? null,
          draft.note ?? null,
          source.raw_text.slice(0, 4096),
          confirmedAt,
          confirmedAt,
          confirmedAt,
        );
      this.replaceAllocations(transactionId, draft.ownerId, draft.allocations);
      this.replaceTags(transactionId, draft.tagIds ?? []);
      this.database
        .prepare(
          "UPDATE drafts SET status = 'confirmed', draft_json = ?, confirmed_transaction_id = ? WHERE draft_id = ?",
        )
        .run(JSON.stringify({ ...draft, status: "confirmed" }), transactionId, draftId);
      const confirmed = this.getTransactionSync(draft.ownerId, transactionId);
      if (!confirmed) throw new Error("confirmed transaction could not be loaded");
      this.insertAudit(
        auditEventId,
        draft.ownerId,
        transactionId,
        draft.sourceEventId,
        "transaction_created",
        null,
        confirmed,
        confirmedAt,
      );
      if (draft.refundTargetTransactionId) {
        void this.linkTransaction({
          linkId: `${transactionId}:refund-link`,
          ownerId: draft.ownerId,
          fromTransactionId: transactionId,
          toTransactionId: draft.refundTargetTransactionId,
          linkType: "refund_of",
          sourceEventId: draft.sourceEventId,
          auditEventId: `${auditEventId}:refund-link`,
          changedAt: confirmedAt,
        });
      }
      return confirmed;
    });
    return Promise.resolve(execute.immediate());
  }

  public cancelDraft(draftId: string): Promise<TransactionDraft> {
    const draft = this.getDraftSync(draftId);
    if (!draft) throw new Error("draft not found");
    if (draft.status === "confirmed") throw new Error("confirmed draft cannot be cancelled");
    const value = TransactionDraftSchema.parse({ ...draft, status: "cancelled" });
    this.database
      .prepare("UPDATE drafts SET status = 'cancelled', draft_json = ? WHERE draft_id = ?")
      .run(JSON.stringify(value), draftId);
    return Promise.resolve(value);
  }

  public getTransaction(
    ownerId: string,
    transactionId: string,
  ): Promise<ConfirmedTransaction | null> {
    return Promise.resolve(this.getTransactionSync(ownerId, transactionId));
  }

  public updateTransaction(command: UpdateTransactionCommand): Promise<ConfirmedTransaction> {
    const execute = this.database.transaction(() => {
      const before = this.requireMutable(command.ownerId, command.transactionId);
      if (before.updatedAt !== command.expectedUpdatedAt)
        throw new Error("stale transaction update");
      const afterInput = ConfirmedTransactionSchema.parse({
        ...command.replacement,
        transactionId: before.transactionId,
        draftId: before.draftId,
        ownerId: before.ownerId,
        requestId: before.requestId,
        sourceEventId: before.sourceEventId,
        sourceType: before.sourceType,
        sourceRef: before.sourceRef,
        confirmedAt: before.confirmedAt,
        createdAt: before.createdAt,
        updatedAt: command.changedAt,
        status: "confirmed",
        deletedAt: undefined,
      });
      const result = this.database
        .prepare(
          `UPDATE transactions SET occurred_date = ?, occurred_time = ?, amount = ?, currency = ?, account_from_id = ?, account_to_id = ?, merchant_id = ?, counterparty_id = ?, note = ?, updated_at = ?
        WHERE transaction_id = ? AND owner_id = ? AND status = 'confirmed' AND updated_at = ?`,
        )
        .run(
          afterInput.occurredDate,
          afterInput.occurredTime ?? null,
          afterInput.amount.amount,
          afterInput.amount.currency,
          afterInput.accountFromId ?? null,
          afterInput.accountToId ?? null,
          afterInput.merchantId ?? null,
          afterInput.counterpartyId ?? null,
          afterInput.note ?? null,
          command.changedAt,
          command.transactionId,
          command.ownerId,
          command.expectedUpdatedAt,
        );
      if (result.changes !== 1) throw new Error("stale transaction update");
      this.database
        .prepare("DELETE FROM transaction_tags WHERE transaction_id = ?")
        .run(command.transactionId);
      this.database
        .prepare("DELETE FROM allocations WHERE transaction_id = ?")
        .run(command.transactionId);
      this.replaceAllocations(command.transactionId, command.ownerId, afterInput.allocations);
      this.replaceTags(command.transactionId, afterInput.tagIds ?? []);
      const after = this.getTransactionSync(command.ownerId, command.transactionId);
      if (!after) throw new Error("updated transaction could not be loaded");
      this.insertAudit(
        command.auditEventId,
        command.ownerId,
        command.transactionId,
        command.sourceEventId,
        "transaction_updated",
        before,
        after,
        command.changedAt,
      );
      return after;
    });
    return Promise.resolve(execute.immediate());
  }

  public softDeleteTransaction(command: DeleteTransactionCommand): Promise<ConfirmedTransaction> {
    const execute = this.database.transaction(() => {
      const before = this.requireMutable(command.ownerId, command.transactionId);
      if (before.updatedAt !== command.expectedUpdatedAt)
        throw new Error("stale transaction update");
      const result = this.database
        .prepare(
          "UPDATE transactions SET status = 'deleted', updated_at = ?, deleted_at = ? WHERE transaction_id = ? AND owner_id = ? AND status = 'confirmed' AND updated_at = ?",
        )
        .run(
          command.changedAt,
          command.changedAt,
          command.transactionId,
          command.ownerId,
          command.expectedUpdatedAt,
        );
      if (result.changes !== 1) throw new Error("stale transaction update");
      const after = this.getTransactionSync(command.ownerId, command.transactionId);
      if (!after) throw new Error("deleted transaction could not be loaded");
      this.insertAudit(
        command.auditEventId,
        command.ownerId,
        command.transactionId,
        command.sourceEventId,
        "transaction_deleted",
        before,
        after,
        command.changedAt,
      );
      return after;
    });
    return Promise.resolve(execute.immediate());
  }

  public linkTransaction(command: LinkTransactionCommand): Promise<void> {
    this.database
      .transaction(() => {
        const refund = this.requireMutable(command.ownerId, command.fromTransactionId);
        const expense = this.requireMutable(command.ownerId, command.toTransactionId);
        if (!refund.allocations.some((item) => item.purpose === "refund"))
          throw new Error("refund link source must be a refund");
        if (!expense.allocations.some((item) => item.purpose === "expense"))
          throw new Error("refund link target must be an expense");
        this.database
          .prepare(
            "INSERT INTO transaction_links (link_id, owner_id, from_transaction_id, to_transaction_id, link_type, source_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            command.linkId,
            command.ownerId,
            command.fromTransactionId,
            command.toTransactionId,
            command.linkType,
            command.sourceEventId,
            command.changedAt,
          );
        this.insertAudit(
          command.auditEventId,
          command.ownerId,
          command.fromTransactionId,
          command.sourceEventId,
          "transaction_linked",
          refund,
          refund,
          command.changedAt,
        );
      })
      .immediate();
    return Promise.resolve();
  }

  public unlinkTransaction(command: UnlinkTransactionCommand): Promise<void> {
    this.database
      .transaction(() => {
        const transaction = this.requireMutable(command.ownerId, command.fromTransactionId);
        const result = this.database
          .prepare(
            "DELETE FROM transaction_links WHERE link_id = ? AND owner_id = ? AND from_transaction_id = ? AND to_transaction_id = ? AND link_type = ?",
          )
          .run(
            command.linkId,
            command.ownerId,
            command.fromTransactionId,
            command.toTransactionId,
            command.linkType,
          );
        if (result.changes !== 1) throw new Error("transaction link not found");
        this.insertAudit(
          command.auditEventId,
          command.ownerId,
          command.fromTransactionId,
          command.sourceEventId,
          "transaction_unlinked",
          transaction,
          transaction,
          command.changedAt,
        );
      })
      .immediate();
    return Promise.resolve();
  }

  public listAuditEvents(ownerId: string, transactionId: string): Promise<AuditEvent[]> {
    const rows = this.database
      .prepare(
        "SELECT * FROM audit_events WHERE owner_id = ? AND transaction_id = ? ORDER BY created_at, rowid",
      )
      .all(ownerId, transactionId) as AuditRow[];
    return Promise.resolve(
      rows.map((row) => ({
        auditEventId: row.audit_event_id,
        ownerId: row.owner_id,
        transactionId: row.transaction_id,
        sourceEventId: row.source_event_id,
        action: row.action,
        before: row.before_json
          ? ConfirmedTransactionSchema.parse(JSON.parse(row.before_json))
          : null,
        after: row.after_json ? ConfirmedTransactionSchema.parse(JSON.parse(row.after_json)) : null,
        createdAt: row.created_at,
      })),
    );
  }

  public listRecent(ownerId: string, limit: number): Promise<ConfirmedTransaction[]> {
    const rows = this.database
      .prepare(
        "SELECT * FROM transactions WHERE owner_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT ?",
      )
      .all(ownerId, limit) as TransactionRow[];
    return Promise.resolve(rows.map((row) => this.toConfirmedTransaction(row)));
  }

  private getDraftSync(draftId: string): TransactionDraft | null {
    const row = this.database
      .prepare("SELECT draft_json FROM drafts WHERE draft_id = ?")
      .get(draftId) as DraftRow | undefined;
    return row ? TransactionDraftSchema.parse(JSON.parse(row.draft_json)) : null;
  }
  private getByRequestId(requestId: string): ConfirmedTransaction | null {
    const row = this.database
      .prepare("SELECT * FROM transactions WHERE request_id = ?")
      .get(requestId) as TransactionRow | undefined;
    return row ? this.toConfirmedTransaction(row) : null;
  }
  private getTransactionSync(ownerId: string, transactionId: string): ConfirmedTransaction | null {
    const row = this.database
      .prepare("SELECT * FROM transactions WHERE owner_id = ? AND transaction_id = ?")
      .get(ownerId, transactionId) as TransactionRow | undefined;
    return row ? this.toConfirmedTransaction(row) : null;
  }
  private requireMutable(ownerId: string, transactionId: string): ConfirmedTransaction {
    const value = this.getTransactionSync(ownerId, transactionId);
    if (!value) throw new Error("transaction not found for owner");
    if (value.status === "deleted") throw new Error("deleted transaction cannot be mutated");
    return value;
  }
  private replaceAllocations(
    transactionId: string,
    ownerId: string,
    allocations: readonly Allocation[],
  ): void {
    const insert = this.database.prepare(
      "INSERT INTO allocations (allocation_id, transaction_id, funds_effect, purpose, amount, currency, category_id, category_snapshot, subcategory_snapshot, counterparty_id, note, recovers_allocation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of allocations) {
      const categoryId =
        item.categoryId ?? this.ensureLegacyCategory(ownerId, item.category, item.subcategory);
      insert.run(
        item.allocationId,
        transactionId,
        item.fundsEffect,
        item.purpose,
        item.amount.amount,
        item.amount.currency,
        categoryId,
        item.category,
        item.subcategory ?? null,
        item.counterpartyId ?? null,
        item.note ?? null,
        item.recoversAllocationId ?? null,
      );
    }
  }
  private replaceTags(transactionId: string, tagIds: readonly string[]): void {
    const insert = this.database.prepare(
      "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
    );
    for (const tagId of tagIds) insert.run(transactionId, tagId);
  }
  private insertAudit(
    auditEventId: string,
    ownerId: string,
    transactionId: string,
    sourceEventId: string,
    action: AuditAction,
    before: ConfirmedTransaction | null,
    after: ConfirmedTransaction | null,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO audit_events (audit_event_id, owner_id, transaction_id, source_event_id, action, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        auditEventId,
        ownerId,
        transactionId,
        sourceEventId,
        action,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        createdAt,
      );
  }
  private ensureLegacyCategory(ownerId: string, category: string, subcategory?: string): string {
    const rootId = `m2:${ownerId}:expense`;
    this.database
      .prepare(
        "INSERT OR IGNORE INTO categories (category_id, owner_id, key, name, kind, depth) VALUES (?, ?, 'expense', '支出', 'expense', 1)",
      )
      .run(rootId, ownerId);
    const lunch =
      ["food", "餐飲"].includes(category) &&
      subcategory !== undefined &&
      ["meal", "午餐"].includes(subcategory);
    const suffix = Buffer.from(`${category}\u0000${subcategory ?? ""}`)
      .toString("hex")
      .toLowerCase();
    const id = lunch ? `m2:${ownerId}:expense_dining_lunch` : `legacy:${ownerId}:${suffix}`;
    this.database
      .prepare(
        "INSERT OR IGNORE INTO categories (category_id, owner_id, key, name, kind, parent_id, depth) VALUES (?, ?, ?, ?, 'expense', ?, 2)",
      )
      .run(
        id,
        ownerId,
        lunch ? "expense_dining_lunch" : `legacy_${suffix}`,
        subcategory ? `${category}／${subcategory}` : category,
        rootId,
      );
    return id;
  }
  private toConfirmedTransaction(row: TransactionRow): ConfirmedTransaction {
    const allocations = this.database
      .prepare("SELECT * FROM allocations WHERE transaction_id = ? ORDER BY rowid")
      .all(row.transaction_id) as AllocationRow[];
    const tags = this.database
      .prepare("SELECT tag_id FROM transaction_tags WHERE transaction_id = ? ORDER BY tag_id")
      .all(row.transaction_id) as { tag_id: string }[];
    return ConfirmedTransactionSchema.parse({
      transactionId: row.transaction_id,
      draftId: row.draft_id,
      ownerId: row.owner_id,
      requestId: row.request_id,
      sourceEventId: row.source_event_id,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      occurredDate: row.occurred_date,
      ...(row.occurred_time ? { occurredTime: row.occurred_time } : {}),
      amount: { amount: row.amount, currency: row.currency },
      allocations: allocations.map((item) => ({
        allocationId: item.allocation_id,
        fundsEffect: item.funds_effect,
        purpose: item.purpose,
        amount: { amount: item.amount, currency: item.currency },
        categoryId: item.category_id,
        category: item.category_snapshot,
        ...(item.subcategory_snapshot ? { subcategory: item.subcategory_snapshot } : {}),
        ...(item.counterparty_id ? { counterpartyId: item.counterparty_id } : {}),
        ...(item.note ? { note: item.note } : {}),
        ...(item.recovers_allocation_id
          ? { recoversAllocationId: item.recovers_allocation_id }
          : {}),
      })),
      ...(row.account_from_id ? { accountFromId: row.account_from_id } : {}),
      ...(row.account_to_id ? { accountToId: row.account_to_id } : {}),
      ...(row.merchant_id ? { merchantId: row.merchant_id } : {}),
      ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
      ...(tags.length ? { tagIds: tags.map((tag) => tag.tag_id) } : {}),
      ...(row.note ? { note: row.note } : {}),
      ...(row.raw_input_snapshot ? { rawInputSnapshot: row.raw_input_snapshot } : {}),
      status: row.status,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    });
  }
}

function toPendingSummary(row: PendingRow): PendingDraftSummary {
  const parsed: unknown = JSON.parse(row.draft_json);
  const rawSegment =
    typeof parsed === "object" && parsed !== null
      ? ((parsed as { partial?: { rawSegment?: string }; rawInputSnapshot?: string }).partial
          ?.rawSegment ??
        (parsed as { rawInputSnapshot?: string }).rawInputSnapshot ??
        "")
      : "";
  return {
    draftId: row.draft_id,
    draftRef: row.draft_ref,
    occurredDate: row.occurred_date,
    amount: row.amount,
    rawSegment,
    createdDate: row.created_date,
  };
}
