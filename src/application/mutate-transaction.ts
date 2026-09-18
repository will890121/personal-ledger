import type { ConfirmedTransaction } from "../domain/ledger.js";
import type {
  DeleteTransactionCommand,
  InputEventInput,
  LedgerRepository,
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

export async function updateConfirmedTransaction(
  command: UpdateTransactionCommand,
  dependencies: MutationDependencies,
): Promise<ConfirmedTransaction> {
  await recordMutationInput(command.sourceEventId, dependencies);
  return dependencies.repository.updateTransaction(command);
}

export async function softDeleteConfirmedTransaction(
  command: DeleteTransactionCommand,
  dependencies: MutationDependencies,
): Promise<ConfirmedTransaction> {
  await recordMutationInput(command.sourceEventId, dependencies);
  return dependencies.repository.softDeleteTransaction(command);
}
