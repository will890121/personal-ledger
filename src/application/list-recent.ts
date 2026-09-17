import type { ConfirmedTransaction } from "../domain/ledger.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function listRecent(
  repository: LedgerRepository,
  ownerId: string,
  requestedLimit = DEFAULT_LIMIT,
): Promise<ConfirmedTransaction[]> {
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIMIT);
  return repository.listRecent(ownerId, limit);
}
