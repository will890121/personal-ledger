import type { LedgerSummary } from "../domain/ledger-summary.js";

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface SummaryRepository {
  summarize(ownerId: string, range: DateRange): Promise<LedgerSummary>;
}
