import type { ConfirmedTransaction } from "../domain/ledger.js";
import type { Account, Category, Merchant } from "../domain/reference-data.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";

export interface ReferenceSnapshot {
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly merchants: readonly Merchant[];
}

export async function loadReferenceSnapshot(
  repository: ReferenceRepository,
  ownerId: string,
): Promise<ReferenceSnapshot> {
  const [accounts, categories, merchants] = await Promise.all([
    repository.listActiveAccounts(ownerId),
    repository.listActiveCategories(ownerId),
    repository.listActiveMerchants(ownerId),
  ]);
  return { accounts, categories, merchants };
}

export async function listRefundCandidates(
  repository: LedgerRepository,
  ownerId: string,
  match: { readonly merchantId?: string; readonly amount?: string },
): Promise<ConfirmedTransaction[]> {
  const transactions = await repository.listRecent(ownerId, 50);
  return transactions
    .filter((transaction) => transaction.allocations.some((item) => item.purpose === "expense"))
    .toSorted((left, right) => {
      const leftMerchant = match.merchantId && left.merchantId === match.merchantId ? 1 : 0;
      const rightMerchant = match.merchantId && right.merchantId === match.merchantId ? 1 : 0;
      if (leftMerchant !== rightMerchant) return rightMerchant - leftMerchant;
      const leftAmount = match.amount && left.amount.amount === match.amount ? 1 : 0;
      const rightAmount = match.amount && right.amount.amount === match.amount ? 1 : 0;
      if (leftAmount !== rightAmount) return rightAmount - leftAmount;
      return right.occurredDate.localeCompare(left.occurredDate);
    });
}
