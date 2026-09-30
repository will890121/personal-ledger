import type { ConfirmedTransaction } from "../domain/ledger.js";
import type {
  DeleteTransactionCommand,
  InputEventInput,
  LedgerRepository,
  OutboxRequest,
  UpdateTransactionCommand,
} from "../ports/ledger-repository.js";

export interface MutationDependencies {
  readonly repository: LedgerRepository;
  readonly inputEvent: InputEventInput;
}

async function recordMutationInput(
  sourceEventId: string,
  dependencies: MutationDependencies,
): Promise<void> {
  if (dependencies.inputEvent.eventId !== sourceEventId) {
    throw new Error("mutation source event mismatch");
  }
  const result = await dependencies.repository.recordInputEvent(dependencies.inputEvent);
  if (!result.created && result.eventId !== sourceEventId) {
    throw new Error("mutation input event conflicts with an existing update");
  }
}

// outbox 是必填：帳本一旦變了就要保證使用者收到訊息，設成選填很容易在新增呼叫端時
// 忘記帶，而漏掉不會有任何編譯錯誤（與 Task 5 的 confirmDraft 同一個理由）。
export async function updateConfirmedTransaction(
  command: UpdateTransactionCommand,
  dependencies: MutationDependencies,
  outbox: OutboxRequest<ConfirmedTransaction>,
): Promise<ConfirmedTransaction> {
  await recordMutationInput(command.sourceEventId, dependencies);
  return dependencies.repository.updateTransaction(command, outbox);
}

export async function softDeleteConfirmedTransaction(
  command: DeleteTransactionCommand,
  dependencies: MutationDependencies,
  outbox: OutboxRequest<ConfirmedTransaction>,
): Promise<ConfirmedTransaction> {
  await recordMutationInput(command.sourceEventId, dependencies);
  return dependencies.repository.softDeleteTransaction(command, outbox);
}
