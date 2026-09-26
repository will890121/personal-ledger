import type { ConfirmedTransaction } from "../domain/ledger.js";
import type {
  Account,
  Category,
  Counterparty,
  Merchant,
  UserCategoryKeyword,
} from "../domain/reference-data.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";

export interface ReferenceSnapshot {
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly merchants: readonly Merchant[];
  readonly counterparties: readonly Counterparty[];
  /** 使用者教過的分類關鍵字；ParseContext 直接展開這份快照，因此加在這裡就會流進解析器。 */
  readonly userKeywords: readonly UserCategoryKeyword[];
}

export async function loadReferenceSnapshot(
  repository: ReferenceRepository,
  ownerId: string,
): Promise<ReferenceSnapshot> {
  const [accounts, categories, merchants, counterparties, userKeywords] = await Promise.all([
    repository.listActiveAccounts(ownerId),
    repository.listActiveCategories(ownerId),
    repository.listActiveMerchants(ownerId),
    repository.listActiveCounterparties(ownerId),
    repository.listUserCategoryKeywords(ownerId),
  ]);
  return { accounts, categories, merchants, counterparties, userKeywords };
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
