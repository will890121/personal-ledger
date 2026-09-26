import { Decimal } from "decimal.js";

import { computeOutstanding, type OutstandingAdvance } from "../domain/advance.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";

export interface CounterpartyAdvances {
  readonly counterpartyId: string;
  readonly name: string;
  readonly total: string;
  readonly items: readonly OutstandingAdvance[];
}

export async function listAdvances(
  repository: LedgerRepository,
  referenceRepository: ReferenceRepository,
  ownerId: string,
): Promise<CounterpartyAdvances[]> {
  const [advanceRows, recoveryRows, counterparties] = await Promise.all([
    repository.listAdvanceRows(ownerId),
    repository.listRecoveryRows(ownerId),
    referenceRepository.listActiveCounterparties(ownerId),
  ]);
  const names = new Map(counterparties.map((item) => [item.counterpartyId, item.name]));
  const grouped = new Map<string, OutstandingAdvance[]>();
  for (const advance of computeOutstanding(advanceRows, recoveryRows)) {
    const items = grouped.get(advance.counterpartyId) ?? [];
    items.push(advance);
    grouped.set(advance.counterpartyId, items);
  }

  return [...grouped.entries()]
    .map(([counterpartyId, items]) => ({
      counterpartyId,
      name: names.get(counterpartyId) ?? counterpartyId,
      total: items.reduce((sum, item) => sum.plus(item.outstanding), new Decimal(0)).toString(),
      items,
    }))
    .sort(
      (left, right) =>
        new Decimal(right.total).comparedTo(left.total) || left.name.localeCompare(right.name),
    );
}
