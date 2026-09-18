import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  ConfirmedTransactionSchema,
  TransactionDraftSchema,
  type Allocation,
  type ConfirmedTransaction,
  type TransactionDraft,
} from "../domain/ledger.js";
import type { InputEventInput, LedgerRepository } from "../ports/ledger-repository.js";

interface DraftRow {
  draft_json: string;
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
  occurred_date: string;
  amount: string;
  currency: "TWD";
  confirmed_at: string;
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
}

export class SqliteLedgerRepository implements LedgerRepository {
  public constructor(private readonly database: Database.Database) {}

  public recordInputEvent(input: InputEventInput): Promise<{
    created: boolean;
    eventId: string;
  }> {
    const result = this.database
      .prepare(
        `INSERT INTO input_events (
          event_id, owner_id, telegram_update_id, source_type, source_ref, raw_text, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (telegram_update_id) DO NOTHING`,
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

    if (result.changes === 1) {
      return Promise.resolve({ created: true, eventId: input.eventId });
    }

    const existing = this.database
      .prepare("SELECT event_id FROM input_events WHERE telegram_update_id = ?")
      .get(input.telegramUpdateId) as EventRow | undefined;

    if (!existing) {
      throw new Error("duplicate input event could not be loaded");
    }

    return Promise.resolve({ created: false, eventId: existing.event_id });
  }

  public saveDraft(draft: TransactionDraft): Promise<void> {
    const parsed = TransactionDraftSchema.parse(draft);
    this.database
      .prepare(
        `INSERT INTO drafts (
          draft_id, owner_id, request_id, source_event_id, occurred_date,
          amount, currency, status, draft_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.draftId,
        parsed.ownerId,
        parsed.requestId,
        parsed.sourceEventId,
        parsed.occurredDate,
        parsed.amount.amount,
        parsed.amount.currency,
        parsed.status,
        JSON.stringify(parsed),
      );
    return Promise.resolve();
  }

  public getDraft(draftId: string): Promise<TransactionDraft | null> {
    const row = this.database
      .prepare("SELECT draft_json FROM drafts WHERE draft_id = ?")
      .get(draftId) as DraftRow | undefined;
    return Promise.resolve(row ? TransactionDraftSchema.parse(JSON.parse(row.draft_json)) : null);
  }

  public confirmDraft(draftId: string, confirmedAt: string): Promise<ConfirmedTransaction> {
    const confirm = this.database.transaction(() => {
      const draft = this.getDraftSync(draftId);
      if (!draft) {
        throw new Error("draft not found");
      }

      const existing = this.getConfirmedByRequestId(draft.requestId);
      if (existing) {
        return existing;
      }
      if (draft.status === "cancelled") {
        throw new Error("cancelled draft cannot be confirmed");
      }

      const sourceEvent = this.database
        .prepare(
          `SELECT event_id, source_type, source_ref, raw_text
           FROM input_events WHERE event_id = ?`,
        )
        .get(draft.sourceEventId) as EventRow | undefined;
      if (!sourceEvent) {
        throw new Error("source event not found");
      }

      const transactionId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO transactions (
            transaction_id, draft_id, owner_id, request_id, source_event_id,
            source_type, source_ref, occurred_date, amount, currency,
            raw_input_snapshot, status, confirmed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
        )
        .run(
          transactionId,
          draft.draftId,
          draft.ownerId,
          draft.requestId,
          draft.sourceEventId,
          sourceEvent.source_type,
          sourceEvent.source_ref,
          draft.occurredDate,
          draft.amount.amount,
          draft.amount.currency,
          sourceEvent.raw_text.slice(0, 4_096),
          confirmedAt,
          confirmedAt,
          confirmedAt,
        );

      const insertAllocation = this.database.prepare(
        `INSERT INTO allocations (
          allocation_id, transaction_id, funds_effect, purpose,
          amount, currency, category_id, category_snapshot, subcategory_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const allocation of draft.allocations) {
        const categoryId = this.ensureLegacyCategory(
          draft.ownerId,
          allocation.category,
          allocation.subcategory,
        );
        insertAllocation.run(
          allocation.allocationId,
          transactionId,
          allocation.fundsEffect,
          allocation.purpose,
          allocation.amount.amount,
          allocation.amount.currency,
          categoryId,
          allocation.category,
          allocation.subcategory ?? null,
        );
      }

      const confirmedDraft: TransactionDraft = { ...draft, status: "confirmed" };
      this.database
        .prepare(
          `UPDATE drafts
           SET status = 'confirmed', draft_json = ?, confirmed_transaction_id = ?
           WHERE draft_id = ?`,
        )
        .run(JSON.stringify(confirmedDraft), transactionId, draftId);

      const confirmed = this.getConfirmedByRequestId(draft.requestId);
      if (!confirmed) {
        throw new Error("confirmed transaction could not be loaded");
      }
      return confirmed;
    });

    return Promise.resolve(confirm.immediate());
  }

  public cancelDraft(draftId: string): Promise<TransactionDraft> {
    const draft = this.getDraftSync(draftId);
    if (!draft) {
      throw new Error("draft not found");
    }
    if (draft.status === "confirmed") {
      throw new Error("confirmed draft cannot be cancelled");
    }

    const cancelled: TransactionDraft = { ...draft, status: "cancelled" };
    this.database
      .prepare("UPDATE drafts SET status = 'cancelled', draft_json = ? WHERE draft_id = ?")
      .run(JSON.stringify(cancelled), draftId);
    return Promise.resolve(cancelled);
  }

  public listRecent(ownerId: string, limit: number): Promise<ConfirmedTransaction[]> {
    const rows = this.database
      .prepare(
        `SELECT * FROM transactions
         WHERE owner_id = ?
         ORDER BY confirmed_at DESC
         LIMIT ?`,
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

  private getConfirmedByRequestId(requestId: string): ConfirmedTransaction | null {
    const row = this.database
      .prepare("SELECT * FROM transactions WHERE request_id = ?")
      .get(requestId) as TransactionRow | undefined;
    return row ? this.toConfirmedTransaction(row) : null;
  }

  private ensureLegacyCategory(
    ownerId: string,
    category: string,
    subcategory: string | undefined,
  ): string {
    const rootId = `m2:${ownerId}:expense`;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO categories (
          category_id, owner_id, key, name, kind, depth
        ) VALUES (?, ?, 'expense', '支出', 'expense', 1)`,
      )
      .run(rootId, ownerId);

    const isLunch =
      ["food", "餐飲"].includes(category) &&
      subcategory !== undefined &&
      ["meal", "午餐"].includes(subcategory);
    const suffix = Buffer.from(`${category}\u0000${subcategory ?? ""}`)
      .toString("hex")
      .toLowerCase();
    const categoryId = isLunch
      ? `m2:${ownerId}:expense_dining_lunch`
      : `legacy:${ownerId}:${suffix}`;
    const key = isLunch ? "expense_dining_lunch" : `legacy_${suffix}`;
    const name = subcategory ? `${category}／${subcategory}` : category;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO categories (
          category_id, owner_id, key, name, kind, parent_id, depth
        ) VALUES (?, ?, ?, ?, 'expense', ?, 2)`,
      )
      .run(categoryId, ownerId, key, name, rootId);
    return categoryId;
  }

  private toConfirmedTransaction(row: TransactionRow): ConfirmedTransaction {
    const allocations = this.database
      .prepare("SELECT * FROM allocations WHERE transaction_id = ? ORDER BY rowid")
      .all(row.transaction_id) as AllocationRow[];

    return ConfirmedTransactionSchema.parse({
      transactionId: row.transaction_id,
      draftId: row.draft_id,
      ownerId: row.owner_id,
      requestId: row.request_id,
      sourceEventId: row.source_event_id,
      occurredDate: row.occurred_date,
      amount: { amount: row.amount, currency: row.currency },
      allocations: allocations.map((allocation) => ({
        allocationId: allocation.allocation_id,
        fundsEffect: allocation.funds_effect,
        purpose: allocation.purpose,
        amount: { amount: allocation.amount, currency: allocation.currency },
        categoryId: allocation.category_id,
        category: allocation.category_snapshot,
        ...(allocation.subcategory_snapshot
          ? { subcategory: allocation.subcategory_snapshot }
          : {}),
      })),
      confirmedAt: row.confirmed_at,
      status: "confirmed",
    });
  }
}
