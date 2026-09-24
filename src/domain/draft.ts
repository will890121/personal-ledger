import { Decimal } from "decimal.js";
import { z } from "zod";

import { AllocationSchema, TransactionDraftSchema, type TransactionDraft } from "./ledger.js";
import { MoneySchema, type Money } from "./money.js";

export const ParseFieldSchema = z.enum([
  "amount",
  "category",
  "account",
  "refundTarget",
  "purpose",
  "counterparty",
  "advanceShare",
]);
export type ParseField = z.infer<typeof ParseFieldSchema>;

export const PendingFieldSchema = z.object({
  field: ParseFieldSchema,
  candidateIds: z.array(z.string().min(1)).default([]),
  proposedName: z.string().trim().min(1).max(100).optional(),
});
export type PendingField = z.infer<typeof PendingFieldSchema>;

export const PartialAllocationSchema = AllocationSchema.omit({ amount: true }).extend({
  amount: MoneySchema.optional(),
});
export type PartialAllocation = z.infer<typeof PartialAllocationSchema>;

export const PartialDraftSchema = z.object({
  occurredDate: z.iso.date(),
  rawSegment: z.string().min(1).max(4_096),
  allocations: z.array(PartialAllocationSchema),
  accountFromId: z.string().min(1).optional(),
  accountToId: z.string().min(1).optional(),
  merchantId: z.string().min(1).optional(),
});
export type PartialDraft = z.infer<typeof PartialDraftSchema>;

export const IncompleteDraftSchema = z.object({
  draftId: z.string().min(1),
  ownerId: z.string().min(1),
  requestId: z.string().min(1),
  sourceEventId: z.string().min(1),
  batchId: z.string().min(1),
  batchIndex: z.number().int().min(0),
  pendingFields: z.array(PendingFieldSchema).min(1),
  partial: PartialDraftSchema,
  status: z.literal("awaiting_input"),
});
export type IncompleteDraft = z.infer<typeof IncompleteDraftSchema>;

export interface DraftPatch {
  readonly amount?: Money;
  readonly categoryId?: string;
  readonly category?: string;
  readonly accountFromId?: string;
  readonly counterpartyId?: string;
  readonly advanceShare?: Money;
}

export type CompleteDraftResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | { readonly kind: "incomplete"; readonly draft: IncompleteDraft };

function applyPatch(partial: PartialDraft, patch: DraftPatch): PartialDraft {
  // 一次分帳可能有好幾筆代墊配置都缺 counterpartyId（例如三人平分、兩個名字都沒解析到）。
  // 一個 counterparty 答案只能填其中一筆，否則不同的債務人會被誤填成同一個人——
  // 靜默產生錯誤資料，比卡住重問更糟。逐人追問時，永遠先補第一筆還缺的。
  let counterpartyAssigned = false;
  const allocations = partial.allocations.map((allocation) => {
    const next = { ...allocation };
    if (patch.amount && !next.amount) next.amount = patch.amount;
    if (patch.category && !allocation.categoryId) {
      next.category = patch.category;
      if (patch.categoryId) next.categoryId = patch.categoryId;
    }
    if (
      patch.counterpartyId &&
      next.purpose === "advance" &&
      !next.counterpartyId &&
      !counterpartyAssigned
    ) {
      next.counterpartyId = patch.counterpartyId;
      counterpartyAssigned = true;
    }
    return next;
  });

  return {
    ...partial,
    allocations,
    ...(patch.accountFromId ? { accountFromId: patch.accountFromId } : {}),
  };
}

function applyAdvanceShare(partial: PartialDraft, share: Money): PartialDraft {
  const total = partial.allocations.reduce(
    (sum, allocation) => sum.plus(allocation.amount?.amount ?? "0"),
    new Decimal(0),
  );
  const allocations = partial.allocations.map((allocation) =>
    allocation.purpose === "advance" ? { ...allocation, amount: share } : allocation,
  );
  const advanceTotal = allocations
    .filter((allocation) => allocation.purpose === "advance")
    .reduce((sum, allocation) => sum.plus(allocation.amount?.amount ?? "0"), new Decimal(0));
  const personal = total.minus(advanceTotal);
  return {
    ...partial,
    allocations: allocations.map((allocation) =>
      allocation.purpose === "expense"
        ? { ...allocation, amount: { amount: personal.toString(), currency: "TWD" as const } }
        : allocation,
    ),
  };
}

function satisfied(field: ParseField, patch: DraftPatch): boolean {
  if (field === "amount") return patch.amount !== undefined;
  if (field === "category") return patch.category !== undefined;
  if (field === "account") return patch.accountFromId !== undefined;
  if (field === "counterparty") return patch.counterpartyId !== undefined;
  if (field === "advanceShare") return patch.advanceShare !== undefined;
  return false;
}

// counterparty 不能只看 patch 有沒有給值就算滿足：一次分帳可能有好幾筆代墊配置，
// 一個答案只填得了一筆，必須從套用 patch 之後的實際配置重新推導還缺不缺。
function hasOutstandingCounterparty(partial: PartialDraft): boolean {
  return partial.allocations.some(
    (allocation) => allocation.purpose === "advance" && !allocation.counterpartyId,
  );
}

export function completeDraft(draft: IncompleteDraft, patch: DraftPatch): CompleteDraftResult {
  const patched = applyPatch(draft.partial, patch);
  const partial = patch.advanceShare ? applyAdvanceShare(patched, patch.advanceShare) : patched;
  const pendingFields = draft.pendingFields.filter((item) =>
    item.field === "counterparty"
      ? hasOutstandingCounterparty(partial)
      : !satisfied(item.field, patch),
  );

  if (pendingFields.length > 0) {
    return {
      kind: "incomplete",
      draft: IncompleteDraftSchema.parse({ ...draft, partial, pendingFields }),
    };
  }

  const total = partial.allocations.reduce(
    (sum, allocation) => sum.plus(allocation.amount?.amount ?? "0"),
    new Decimal(0),
  );
  const candidate = TransactionDraftSchema.safeParse({
    draftId: draft.draftId,
    ownerId: draft.ownerId,
    requestId: draft.requestId,
    sourceEventId: draft.sourceEventId,
    occurredDate: partial.occurredDate,
    amount: { amount: total.toString(), currency: "TWD" },
    allocations: partial.allocations,
    ...(partial.accountFromId ? { accountFromId: partial.accountFromId } : {}),
    ...(partial.accountToId ? { accountToId: partial.accountToId } : {}),
    ...(partial.merchantId ? { merchantId: partial.merchantId } : {}),
    rawInputSnapshot: partial.rawSegment,
    status: "awaiting_confirmation",
  });

  if (!candidate.success) {
    // 欄位都補齊了但仍無法通過領域驗證：保留原本的待補欄位，草稿不升級。
    return { kind: "incomplete", draft: IncompleteDraftSchema.parse({ ...draft, partial }) };
  }
  return { kind: "draft", draft: candidate.data };
}
