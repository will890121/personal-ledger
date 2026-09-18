import type { ConfirmedTransaction, TransactionDraft } from "../domain/ledger.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";

export function confirmDraft(
  repository: LedgerRepository,
  draftId: string,
  confirmedAt: string,
): Promise<ConfirmedTransaction> {
  return repository.confirmDraft(draftId, confirmedAt);
}

export function cancelDraft(
  repository: LedgerRepository,
  draftId: string,
): Promise<TransactionDraft> {
  return repository.cancelDraft(draftId);
}
