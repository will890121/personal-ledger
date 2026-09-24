import {
  completeDraft,
  type DraftPatch,
  type IncompleteDraft,
  type ParseField,
} from "../domain/draft.js";
import type { TransactionDraft } from "../domain/ledger.js";
import { money } from "../domain/money.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";

const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

export type AnswerValue =
  | { readonly kind: "amount"; readonly text: string }
  | { readonly kind: "reference"; readonly id: string; readonly label: string };

export interface AnswerDraftCommand {
  readonly ownerId: string;
  readonly draftId: string;
  readonly field: ParseField;
  readonly value: AnswerValue;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly rawText: string;
  readonly receivedAt: string;
}

export interface AnswerDraftDependencies {
  readonly repository: LedgerRepository;
  readonly generateId: () => string;
}

export type AnswerDraftResult =
  | { readonly kind: "draft"; readonly draft: TransactionDraft }
  | { readonly kind: "incomplete"; readonly draft: IncompleteDraft }
  | {
      readonly kind: "invalid";
      readonly reason: "draft_not_found" | "not_pending" | "amount_not_numeric";
    };

function patchFor(command: AnswerDraftCommand): DraftPatch {
  if (command.value.kind === "amount") {
    return { amount: money(command.value.text.trim(), "TWD") };
  }
  if (command.field === "account") return { accountFromId: command.value.id };
  return { categoryId: command.value.id, category: command.value.label };
}

export async function answerDraft(
  command: AnswerDraftCommand,
  dependencies: AnswerDraftDependencies,
): Promise<AnswerDraftResult> {
  const record = await dependencies.repository.getDraftRecord({ draftId: command.draftId });
  if (!record?.incomplete || record.ownerId !== command.ownerId) {
    return { kind: "invalid", reason: "draft_not_found" };
  }
  if (!record.incomplete.pendingFields.some((item) => item.field === command.field)) {
    return { kind: "invalid", reason: "not_pending" };
  }
  if (command.value.kind === "amount" && !AMOUNT_PATTERN.test(command.value.text.trim())) {
    return { kind: "invalid", reason: "amount_not_numeric" };
  }

  // 追問的回答本身也是不可變輸入事件，必須在異動草稿之前留下紀錄。
  await dependencies.repository.recordInputEvent({
    eventId: dependencies.generateId(),
    ownerId: command.ownerId,
    telegramUpdateId: command.telegramUpdateId,
    sourceType: "telegram",
    sourceRef: command.sourceRef,
    rawText: command.rawText,
    receivedAt: command.receivedAt,
  });

  const result = completeDraft(record.incomplete, patchFor(command));
  await dependencies.repository.replaceDraft(command.draftId, result.draft);
  return result;
}
