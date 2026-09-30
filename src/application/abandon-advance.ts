import { computeOutstanding, splitForAbandonment } from "../domain/advance.js";
import type { ConfirmedTransaction } from "../domain/ledger.js";
import type { LedgerRepository, OutboxRequest } from "../ports/ledger-repository.js";
import { updateConfirmedTransaction } from "./mutate-transaction.js";

export interface AbandonAdvanceCommand {
  readonly ownerId: string;
  readonly allocationId: string;
  readonly telegramUpdateId: string;
  readonly sourceRef: string;
  readonly receivedAt: string;
}

export interface AbandonAdvanceDependencies {
  readonly repository: LedgerRepository;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export type AbandonAdvanceResult =
  | {
      readonly kind: "abandoned";
      readonly transaction: ConfirmedTransaction;
      readonly amount: string;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "nothing_to_abandon" };

// 把一筆代墊的未回收餘額轉為個人消費：已回收的部分維持代墊記錄不變，
// 未回收的部分改列為 expense，交易日期沿用原交易，不使用今天的日期。
//
// outbox 是必填、且只在下面「放棄成功」這一條路徑用到一次：not_found／nothing_to_abandon
// 兩種提早返回都還沒真的動到帳本，不該也不會產生任何 outbox 列。放棄動作底層借用
// updateConfirmedTransaction（同一個函式，一般編輯交易也會用到它），但呼叫處只有這一個，
// 所以這一個使用者動作最終只會寫入一列——不是靠額外的「不寫 outbox 的私有路徑」去擋，
// 而是根本沒有第二個會寫 outbox 的呼叫。
export async function abandonAdvance(
  command: AbandonAdvanceCommand,
  dependencies: AbandonAdvanceDependencies,
  outbox: OutboxRequest<ConfirmedTransaction>,
): Promise<AbandonAdvanceResult> {
  const [advanceRows, recoveryRows] = await Promise.all([
    dependencies.repository.listAdvanceRows(command.ownerId),
    dependencies.repository.listRecoveryRows(command.ownerId),
  ]);
  const outstanding = computeOutstanding(advanceRows, recoveryRows).find(
    (item) => item.allocationId === command.allocationId,
  );
  if (!outstanding) {
    // 找不到未回收餘額有兩種可能：這筆代墊根本不存在，或已全額回收。
    const known = advanceRows.some((row) => row.allocationId === command.allocationId);
    return known ? { kind: "nothing_to_abandon" } : { kind: "not_found" };
  }

  const before = await dependencies.repository.getTransaction(
    command.ownerId,
    outstanding.transactionId,
  );
  if (!before) return { kind: "not_found" };

  const allocations = splitForAbandonment(
    before.allocations,
    command.allocationId,
    outstanding.recovered,
    dependencies.generateId(),
  );

  const changedAt = dependencies.now().toISOString();
  const eventId = dependencies.generateId();
  const transaction = await updateConfirmedTransaction(
    {
      ownerId: command.ownerId,
      transactionId: before.transactionId,
      sourceEventId: eventId,
      auditEventId: dependencies.generateId(),
      expectedUpdatedAt: before.updatedAt ?? before.confirmedAt,
      // occurredDate 等其他欄位沿用 before，放棄的消費歸屬原交易日期，不是今天。
      replacement: { ...before, allocations },
      changedAt,
    },
    {
      repository: dependencies.repository,
      inputEvent: {
        eventId,
        ownerId: command.ownerId,
        telegramUpdateId: command.telegramUpdateId,
        sourceType: "telegram",
        sourceRef: command.sourceRef,
        rawText: "abandon advance callback",
        receivedAt: command.receivedAt,
      },
    },
    outbox,
  );

  return { kind: "abandoned", transaction, amount: outstanding.outstanding };
}
