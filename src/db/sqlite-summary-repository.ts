import type Database from "better-sqlite3";

import {
  summarizeAllocations,
  type LedgerSummary,
  type SummaryAllocation,
} from "../domain/ledger-summary.js";
import type { DateRange, SummaryRepository } from "../ports/summary-repository.js";

interface SummaryRow {
  funds_effect: SummaryAllocation["fundsEffect"];
  purpose: SummaryAllocation["purpose"];
  amount: string;
  category_id: string;
  category_key: string;
  category_name: string;
}

export class SqliteSummaryRepository implements SummaryRepository {
  public constructor(private readonly database: Database.Database) {}

  public summarize(ownerId: string, range: DateRange): Promise<LedgerSummary> {
    const rows = this.database
      .prepare(
        `SELECT a.funds_effect, a.purpose, a.amount,
        a.category_id, c.key AS category_key, c.name AS category_name
      FROM transactions t
      JOIN allocations a ON a.transaction_id = t.transaction_id
      JOIN categories c ON c.category_id = a.category_id AND c.owner_id = t.owner_id
      WHERE t.owner_id = ? AND t.status = 'confirmed'
        AND t.occurred_date >= ? AND t.occurred_date <= ?
      ORDER BY t.occurred_date, t.transaction_id, a.rowid`,
      )
      .all(ownerId, range.from, range.to) as SummaryRow[];
    return Promise.resolve(
      summarizeAllocations(
        rows.map((row) => ({
          fundsEffect: row.funds_effect,
          purpose: row.purpose,
          amount: row.amount,
          categoryId: row.category_id,
          categoryKey: row.category_key,
          categoryName: row.category_name,
        })),
      ),
    );
  }
}
