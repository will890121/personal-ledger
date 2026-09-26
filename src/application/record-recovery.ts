import { Decimal } from "decimal.js";

import { computeOutstanding, planRecovery } from "../domain/advance.js";
import { IncompleteDraftSchema, type IncompleteDraft } from "../domain/draft.js";
import { TransactionDraftSchema, type TransactionDraft } from "../domain/ledger.js";
import { money } from "../domain/money.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";

export interface RecordRecoveryCommand {
  readonly ownerId: string;
  readonly counterpartyId: string;
  readonly received: string;
  readonly occurredDate: string;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly rawText: string;
  readonly receivedAt: string;
  readonly accountToId?: string;
}

export interface RecordRecoveryDependencies {
  readonly repository: LedgerRepository;
  readonly generateId: () => string;
  // 由呼叫端自參照資料快照取出啟用中的收入葉分類 ID，供超額回收的待補分類欄位使用。
  readonly incomeCategoryIds: readonly string[];
}

// 超額回收沖抵了哪幾筆代墊、各沖抵多少：追問分類時要把這份摘要交給 Telegram 層，
// 讓它能組出「其中 630 沖抵 2026-09-25 的代墊」這類有脈絡的文案，而不必額外查表。
export interface RecoveredAdvanceSummary {
  readonly occurredDate: string;
  readonly amount: string;
}

export type RecordRecoveryResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft; readonly draftRef: string }
  | {
      readonly kind: "incomplete";
      readonly draft: IncompleteDraft;
      readonly draftRef: string;
      readonly surplus: string;
      readonly recovered: readonly RecoveredAdvanceSummary[];
    }
  | { readonly kind: "no_outstanding" }
  | { readonly kind: "duplicate" };

export async function recordRecovery(
  command: RecordRecoveryCommand,
  dependencies: RecordRecoveryDependencies,
): Promise<RecordRecoveryResult> {
  const eventId = dependencies.generateId();
  const recorded = await dependencies.repository.recordInputEvent({
    eventId,
    ownerId: command.ownerId,
    telegramUpdateId: command.telegramUpdateId,
    sourceType: "telegram",
    sourceRef: command.sourceRef,
    rawText: command.rawText,
    receivedAt: command.receivedAt,
  });
  if (!recorded.created) return { kind: "duplicate" };

  const [advanceRows, recoveryRows] = await Promise.all([
    dependencies.repository.listAdvanceRows(command.ownerId),
    dependencies.repository.listRecoveryRows(command.ownerId),
  ]);
  const outstanding = computeOutstanding(advanceRows, recoveryRows).filter(
    (item) => item.counterpartyId === command.counterpartyId,
  );
  if (outstanding.length === 0) return { kind: "no_outstanding" };

  const plan = planRecovery(outstanding, command.received);
  const allocations = plan.items.map((item) => ({
    allocationId: dependencies.generateId(),
    fundsEffect: "inflow" as const,
    purpose: "advance_recovery" as const,
    amount: money(item.amount, "TWD"),
    // 回收配置沿用被回收代墊的分類與交易對象，不另外詢問。
    ...(item.advance.categoryId ? { categoryId: item.advance.categoryId } : {}),
    category: item.advance.category,
    ...(item.advance.subcategory ? { subcategory: item.advance.subcategory } : {}),
    counterpartyId: item.advance.counterpartyId,
    recoversAllocationId: item.advance.allocationId,
  }));

  const base = {
    draftId: dependencies.generateId(),
    ownerId: command.ownerId,
    requestId: dependencies.generateId(),
    sourceEventId: eventId,
    occurredDate: command.occurredDate,
    ...(command.accountToId ? { accountToId: command.accountToId } : {}),
  };

  if (new Decimal(plan.surplus).greaterThan(0)) {
    // drafts.batch_id 是外鍵指向 batches 表，即使超額回收草稿只有單一段落，
    // 仍必須先寫入一列 batches 供其參照，否則儲存草稿時會違反外鍵限制。
    const batchId = dependencies.generateId();
    await dependencies.repository.saveBatch({
      batchId,
      ownerId: command.ownerId,
      sourceEventId: eventId,
      itemCount: 1,
      createdAt: command.receivedAt,
    });

    const draft = IncompleteDraftSchema.parse({
      ...base,
      batchId,
      batchIndex: 0,
      pendingFields: [
        {
          field: "category",
          candidateIds: dependencies.incomeCategoryIds,
        },
      ],
      partial: {
        occurredDate: command.occurredDate,
        rawSegment: command.rawText,
        allocations: [
          ...allocations,
          {
            allocationId: dependencies.generateId(),
            fundsEffect: "inflow" as const,
            purpose: "income" as const,
            amount: money(plan.surplus, "TWD"),
            category: "待分類",
          },
        ],
      },
      status: "awaiting_input",
    });
    const draftRef = await dependencies.repository.saveIncompleteDraft(draft, {
      batchId,
      batchIndex: 0,
      createdDate: command.occurredDate,
    });
    const recovered = plan.items.map((item) => ({
      occurredDate: item.advance.occurredDate,
      amount: item.amount,
    }));
    return { kind: "incomplete", draft, draftRef, surplus: plan.surplus, recovered };
  }

  const total = allocations.reduce((sum, item) => sum.plus(item.amount.amount), new Decimal(0));
  const draft = TransactionDraftSchema.parse({
    ...base,
    amount: money(total.toString(), "TWD"),
    allocations,
    rawInputSnapshot: command.rawText,
    status: "awaiting_confirmation",
  });
  const draftRef = await dependencies.repository.saveDraft(draft, {
    createdDate: command.occurredDate,
  });
  return { kind: "draft", draft, draftRef };
}
