import { IncompleteDraftSchema, type IncompleteDraft } from "../../src/domain/draft.js";
import { TransactionDraftSchema, type TransactionDraft } from "../../src/domain/ledger.js";
import type { Category } from "../../src/domain/reference-data.js";

export function incompleteLunchDraft(
  overrides: Partial<IncompleteDraft> = {},
): IncompleteDraft {
  return IncompleteDraftSchema.parse({
    draftId: "draft-1",
    ownerId: "owner-1",
    requestId: "request-1",
    sourceEventId: "event-1",
    batchId: "batch-1",
    batchIndex: 0,
    pendingFields: [{ field: "amount", candidateIds: [] }],
    partial: {
      occurredDate: "2026-09-21",
      rawSegment: "午餐",
      allocations: [
        {
          allocationId: "allocation-1",
          fundsEffect: "outflow",
          purpose: "expense",
          categoryId: "category-lunch",
          category: "餐飲",
          subcategory: "午餐",
        },
      ],
    },
    status: "awaiting_input",
    ...overrides,
  });
}

export function incompleteDraftWithPendingCategory(candidateIds: string[]): IncompleteDraft {
  return IncompleteDraftSchema.parse({
    draftId: "draft-2",
    ownerId: "owner-1",
    requestId: "request-2",
    sourceEventId: "event-1",
    batchId: "batch-1",
    batchIndex: 1,
    pendingFields: [{ field: "category", candidateIds }],
    partial: {
      occurredDate: "2026-09-21",
      rawSegment: "咖啡 60",
      allocations: [
        {
          allocationId: "allocation-2",
          fundsEffect: "outflow",
          purpose: "expense",
          amount: { amount: "60", currency: "TWD" },
          category: "待分類",
        },
      ],
    },
    status: "awaiting_input",
  });
}

export function completeLunchDraft(
  overrides: Partial<TransactionDraft> = {},
): TransactionDraft {
  return TransactionDraftSchema.parse({
    draftId: "draft-3",
    ownerId: "owner-1",
    requestId: "request-3",
    sourceEventId: "event-1",
    occurredDate: "2026-09-21",
    amount: { amount: "120", currency: "TWD" },
    allocations: [
      {
        allocationId: "allocation-3",
        fundsEffect: "outflow",
        purpose: "expense",
        amount: { amount: "120", currency: "TWD" },
        categoryId: "category-lunch",
        category: "餐飲",
        subcategory: "午餐",
      },
    ],
    status: "awaiting_confirmation",
    ...overrides,
  });
}

export function expenseCategories(ids: string[]): Category[] {
  return ids.map((categoryId, index) => ({
    categoryId,
    ownerId: "owner-1",
    key: `expense_fixture_${String(index)}`,
    name: `分類 ${String(index)}`,
    kind: "expense" as const,
    parentId: "category-expense-root",
    depth: 2 as const,
    active: true,
  }));
}
