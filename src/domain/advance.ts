import { Decimal } from "decimal.js";

import type { Allocation } from "./ledger.js";

export interface AdvanceRow {
  readonly allocationId: string;
  readonly transactionId: string;
  readonly occurredDate: string;
  readonly counterpartyId: string;
  readonly categoryId?: string;
  readonly category: string;
  readonly subcategory?: string;
  readonly amount: string;
}

export interface RecoveryRow {
  readonly recoversAllocationId: string;
  readonly amount: string;
}

export interface OutstandingAdvance {
  readonly allocationId: string;
  readonly transactionId: string;
  readonly occurredDate: string;
  readonly counterpartyId: string;
  readonly categoryId?: string;
  readonly category: string;
  readonly subcategory?: string;
  readonly amount: string;
  readonly recovered: string;
  readonly outstanding: string;
}

export interface RecoveryPlanItem {
  readonly advance: OutstandingAdvance;
  readonly amount: string;
}

export interface RecoveryPlan {
  readonly items: readonly RecoveryPlanItem[];
  readonly surplus: string;
}

export function computeOutstanding(
  advances: readonly AdvanceRow[],
  recoveries: readonly RecoveryRow[],
): OutstandingAdvance[] {
  const recovered = new Map<string, Decimal>();
  for (const row of recoveries) {
    const current = recovered.get(row.recoversAllocationId) ?? new Decimal(0);
    recovered.set(row.recoversAllocationId, current.plus(row.amount));
  }

  return advances
    .map((advance) => {
      const paid = recovered.get(advance.allocationId) ?? new Decimal(0);
      const outstanding = new Decimal(advance.amount).minus(paid);
      return { ...advance, recovered: paid.toString(), outstanding: outstanding.toString() };
    })
    .filter((item) => new Decimal(item.outstanding).greaterThan(0))
    .sort(
      (left, right) =>
        left.occurredDate.localeCompare(right.occurredDate) ||
        left.allocationId.localeCompare(right.allocationId),
    );
}

export function planRecovery(
  advances: readonly OutstandingAdvance[],
  received: string,
): RecoveryPlan {
  let remaining = new Decimal(received);
  const items: RecoveryPlanItem[] = [];

  for (const advance of advances) {
    if (!remaining.greaterThan(0)) break;
    const outstanding = new Decimal(advance.outstanding);
    const applied = Decimal.min(outstanding, remaining);
    items.push({ advance, amount: applied.toString() });
    remaining = remaining.minus(applied);
  }

  return { items, surplus: remaining.toString() };
}

export function splitForAbandonment(
  allocations: readonly Allocation[],
  allocationId: string,
  recovered: string,
  newAllocationId: string,
): Allocation[] {
  const target = allocations.find((item) => item.allocationId === allocationId);
  if (!target || target.purpose !== "advance") throw new Error("advance allocation not found");

  const total = new Decimal(target.amount.amount);
  const paid = new Decimal(recovered);
  const abandoned = total.minus(paid);
  if (!abandoned.greaterThan(0)) throw new Error("nothing left to abandon");

  // 尚未回收任何金額：整筆轉為個人消費。拆分會讓代墊金額變成 0，違反金額必須為正。
  if (!paid.greaterThan(0)) {
    return allocations.map((item) =>
      item.allocationId === allocationId ? { ...item, purpose: "expense" as const } : item,
    );
  }

  return allocations.flatMap((item) => {
    if (item.allocationId !== allocationId) return [item];
    return [
      { ...item, amount: { ...item.amount, amount: paid.toString() } },
      {
        ...item,
        allocationId: newAllocationId,
        purpose: "expense" as const,
        amount: { ...item.amount, amount: abandoned.toString() },
      },
    ];
  });
}
