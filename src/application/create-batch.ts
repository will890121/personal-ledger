import { IncompleteDraftSchema, type IncompleteDraft, type ParseField } from "../domain/draft.js";
import type { TransactionDraft } from "../domain/ledger.js";
import { parseTransaction, type ParseResult } from "../parser/rule-parser.js";
import { splitInput } from "../parser/split-input.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";
import { loadReferenceSnapshot, type ReferenceSnapshot } from "./reference-data.js";

export const MAX_SEGMENTS = 10;

export interface CreateBatchCommand {
  readonly ownerId: string;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly occurredDate: string;
}

export interface CreateBatchDependencies {
  readonly repository: LedgerRepository;
  readonly referenceRepository: ReferenceRepository;
  readonly generateId: () => string;
}

export type BatchItemOutcome =
  | { readonly kind: "draft"; readonly draft: TransactionDraft; readonly draftRef: string }
  | { readonly kind: "incomplete"; readonly draft: IncompleteDraft; readonly draftRef: string }
  | { readonly kind: "unparsed"; readonly reason: "unresolved_purpose" | "ambiguous" };

export interface BatchItem {
  readonly index: number;
  readonly segment: string;
  readonly outcome: BatchItemOutcome;
}

export type CreateBatchResult =
  | { readonly kind: "batch"; readonly batchId: string; readonly items: readonly BatchItem[] }
  | { readonly kind: "duplicate"; readonly eventId: string }
  | { readonly kind: "too_many_segments"; readonly count: number }
  | { readonly kind: "empty" };

function candidatesFor(
  field: ParseField,
  references: ReferenceSnapshot,
  parsed: ParseResult,
): string[] {
  if (parsed.kind === "ambiguous" && parsed.field === field) return [...parsed.candidateIds];
  if (field === "category") {
    return references.categories
      .filter((item) => item.active && item.kind === "expense" && item.depth === 2)
      .map((item) => item.categoryId);
  }
  if (field === "account") {
    return references.accounts.filter((item) => item.active).map((item) => item.accountId);
  }
  return [];
}

interface PersistContext {
  readonly repository: LedgerRepository;
  readonly references: ReferenceSnapshot;
  readonly ownerId: string;
  readonly sourceEventId: string;
  readonly batchId: string;
  readonly index: number;
  readonly draftId: string;
  readonly requestId: string;
  readonly createdDate: string;
}

async function persist(parsed: ParseResult, context: PersistContext): Promise<BatchItemOutcome> {
  const meta = {
    batchId: context.batchId,
    batchIndex: context.index,
    createdDate: context.createdDate,
  };

  if (parsed.kind === "draft") {
    const draftRef = await context.repository.saveDraft(parsed.draft, meta);
    return { kind: "draft", draft: parsed.draft, draftRef };
  }

  if (parsed.kind === "ambiguous") {
    return { kind: "unparsed", reason: "ambiguous" };
  }

  // 沒有任何配置殼就無法靠追問湊出合法草稿，視為完全無法解析，不建草稿。
  if (parsed.partial.allocations.length === 0) {
    return { kind: "unparsed", reason: "unresolved_purpose" };
  }

  const draft = IncompleteDraftSchema.parse({
    draftId: context.draftId,
    ownerId: context.ownerId,
    requestId: context.requestId,
    sourceEventId: context.sourceEventId,
    batchId: context.batchId,
    batchIndex: context.index,
    pendingFields: parsed.fields.map((field) => ({
      field,
      candidateIds: candidatesFor(field, context.references, parsed),
    })),
    partial: parsed.partial,
    status: "awaiting_input",
  });
  const draftRef = await context.repository.saveIncompleteDraft(draft, meta);
  return { kind: "incomplete", draft, draftRef };
}

export async function createBatch(
  command: CreateBatchCommand,
  dependencies: CreateBatchDependencies,
): Promise<CreateBatchResult> {
  const segments = splitInput(command.text);
  if (segments.length === 0) return { kind: "empty" };
  if (segments.length > MAX_SEGMENTS) {
    return { kind: "too_many_segments", count: segments.length };
  }

  const eventId = dependencies.generateId();
  const recorded = await dependencies.repository.recordInputEvent({
    eventId,
    ownerId: command.ownerId,
    telegramUpdateId: command.telegramUpdateId,
    sourceType: "telegram",
    sourceRef: command.sourceRef,
    rawText: command.text,
    receivedAt: command.receivedAt,
  });
  if (!recorded.created) return { kind: "duplicate", eventId: recorded.eventId };

  const references = await loadReferenceSnapshot(
    dependencies.referenceRepository,
    command.ownerId,
  );
  const batchId = dependencies.generateId();
  await dependencies.repository.saveBatch({
    batchId,
    ownerId: command.ownerId,
    sourceEventId: eventId,
    itemCount: segments.length,
    createdAt: command.receivedAt,
  });

  const items: BatchItem[] = [];
  for (const [index, segment] of segments.entries()) {
    const draftId = dependencies.generateId();
    const requestId = dependencies.generateId();
    const parsed = parseTransaction(segment, {
      ownerId: command.ownerId,
      requestId,
      sourceEventId: eventId,
      draftId,
      allocationId: dependencies.generateId(),
      additionalAllocationId: dependencies.generateId(),
      today: command.occurredDate,
      ...references,
    });
    const outcome = await persist(parsed, {
      repository: dependencies.repository,
      references,
      ownerId: command.ownerId,
      sourceEventId: eventId,
      batchId,
      index,
      draftId,
      requestId,
      createdDate: command.occurredDate,
    });
    items.push({ index, segment, outcome });
  }

  return { kind: "batch", batchId, items };
}
