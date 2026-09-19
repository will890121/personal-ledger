import {
  ConfirmedTransactionSchema,
  TransactionDraftSchema,
  type ConfirmedTransaction,
  type TransactionDraft,
} from "../../src/domain/ledger.js";
import type {
  AuditEvent,
  DeleteTransactionCommand,
  InputEventInput,
  LedgerRepository,
  UpdateTransactionCommand,
} from "../../src/ports/ledger-repository.js";

export class FakeLedgerRepository implements LedgerRepository {
  public readonly inputEvents = new Map<string, InputEventInput>();
  public readonly drafts = new Map<string, TransactionDraft>();
  public readonly transactions = new Map<string, ConfirmedTransaction>();

  public recordInputEvent(input: InputEventInput): Promise<{ created: boolean; eventId: string }> {
    const existing = this.inputEvents.get(input.telegramUpdateId);
    if (existing) {
      return Promise.resolve({ created: false, eventId: existing.eventId });
    }
    this.inputEvents.set(input.telegramUpdateId, input);
    return Promise.resolve({ created: true, eventId: input.eventId });
  }

  public saveDraft(draft: TransactionDraft): Promise<void> {
    this.drafts.set(draft.draftId, TransactionDraftSchema.parse(draft));
    return Promise.resolve();
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
