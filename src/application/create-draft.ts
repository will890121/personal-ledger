import type { TransactionDraft } from "../domain/ledger.js";
import { parseTransaction, type ParseResult } from "../parser/rule-parser.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";

export interface CreateDraftCommand {
  readonly ownerId: string;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly occurredDate: string;
}

export interface CreateDraftDependencies {
  readonly repository: LedgerRepository;
  readonly generateId: () => string;
}

export type CreateDraftResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | Extract<ParseResult, { kind: "missing_fields" }>
  | { readonly kind: "duplicate"; readonly eventId: string };

export async function createDraft(
  command: CreateDraftCommand,
  dependencies: CreateDraftDependencies,
): Promise<CreateDraftResult> {
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

  if (!recorded.created) {
    return { kind: "duplicate", eventId: recorded.eventId };
  }

  const parsed = parseTransaction(command.text, {
    ownerId: command.ownerId,
    requestId: dependencies.generateId(),
    sourceEventId: eventId,
    draftId: dependencies.generateId(),
    allocationId: dependencies.generateId(),
    today: command.occurredDate,
  });

  if (parsed.kind === "missing_fields") {
    return parsed;
  }

  await dependencies.repository.saveDraft(parsed.draft);
  return parsed;
}
