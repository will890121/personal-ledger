import type { ConfirmedTransaction, TransactionDraft } from "../domain/ledger.js";
import type { LedgerRepository, OutboxRequest } from "../ports/ledger-repository.js";

export function confirmDraft(
  repository: LedgerRepository,
  draftId: string,
  confirmedAt: string,
  auditEventId: string,
  outbox: OutboxRequest<ConfirmedTransaction>,
): Promise<ConfirmedTransaction> {
  return repository.confirmDraft(draftId, confirmedAt, auditEventId, outbox);
}

export function cancelDraft(
  repository: LedgerRepository,
  draftId: string,
): Promise<TransactionDraft> {
  return repository.cancelDraft(draftId);
}
