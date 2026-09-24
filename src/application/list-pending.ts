import type {
  LedgerRepository,
  PendingDraftSummary,
  PendingStatus,
} from "../ports/ledger-repository.js";

export const PENDING_PAGE_SIZE = 10;

export interface PendingPage {
  readonly status: PendingStatus;
  readonly page: number;
  readonly totalPages: number;
  readonly items: readonly PendingDraftSummary[];
}

export async function listPending(
  repository: LedgerRepository,
  ownerId: string,
  status: PendingStatus,
  page: number,
): Promise<PendingPage> {
  const total = await repository.countPendingDrafts(ownerId, status);
  const items = await repository.listPendingDrafts({
    ownerId,
    status,
    limit: PENDING_PAGE_SIZE,
    offset: page * PENDING_PAGE_SIZE,
  });
  return { status, page, totalPages: Math.ceil(total / PENDING_PAGE_SIZE), items };
}
