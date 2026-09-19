import type { LedgerSummary } from "../domain/ledger-summary.js";
import type { SummaryRepository } from "../ports/summary-repository.js";

export interface SummaryDependencies {
  readonly repository: SummaryRepository;
  readonly today: () => string;
}

export function getTodaySummary(
  ownerId: string,
  dependencies: SummaryDependencies,
): Promise<LedgerSummary> {
  const today = dependencies.today();
  return dependencies.repository.summarize(ownerId, { from: today, to: today });
}

export function getMonthSummary(
  ownerId: string,
  dependencies: SummaryDependencies,
): Promise<LedgerSummary> {
  const today = dependencies.today();
  return dependencies.repository.summarize(ownerId, { from: `${today.slice(0, 7)}-01`, to: today });
}
