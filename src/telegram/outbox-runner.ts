import { GrammyError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import { MAX_ATTEMPTS, backoffMs, type OutboxMessage } from "../domain/outbox.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";
import { classifyDeliveryError } from "./delivery-error.js";

/**
 * 把 outbox 裡的訊息真的送出去。設計上刻意沒有獨立的「開機恢復」路徑：
 * 行程在遞送途中死掉，會留下一個尚未過期的 lease；等它過期，
 * 一般的 drain 迴圈用平常的規則就能重新撈到那一列，不需要另一段只有開機時
 * 才會跑、平常沒人測過的程式碼。
 *
 * 已知且接受的重複：送出成功、但在 markOutboxDelivered 落地前行程死掉，
 * lease 過期後會被同一個迴圈再送一次——帳本只有一筆、使用者看到兩則訊息。
 * 寧可重複也不要遺失；lease 的長度就是這個重複的上限，不會無限重複。
 */

const LEASE_MS = 30_000;
const BATCH = 10;
const DRAIN_INTERVAL_MS = 5_000;

export interface OutboxSendOptions {
  readonly reply_markup?: InlineKeyboardMarkup;
}

/**
 * 刻意收窄的介面：只暴露遞送用得到的兩個呼叫，測試不需要整個 grammY Bot。
 */
export interface OutboxApi {
  sendMessage(
    chatId: string,
    text: string,
    options: OutboxSendOptions,
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: OutboxSendOptions,
  ): Promise<unknown>;
}

export interface OutboxRunnerDependencies {
  readonly repository: LedgerRepository;
  readonly ownerId: string;
  readonly api: OutboxApi;
  readonly now: () => Date;
  readonly onNeedsAttention: (message: OutboxMessage) => Promise<void>;
}

type DeliveryResult = "delivered" | "retrying" | "needs_attention";

function buildOptions(message: OutboxMessage): OutboxSendOptions {
  if (!message.replyMarkup) return {};
  return { reply_markup: JSON.parse(message.replyMarkup) as InlineKeyboardMarkup };
}

// GrammyError 的 description 是 Telegram Bot API 回傳的錯誤描述，不含使用者輸入或
// 財務資料，存進 last_error 供 /status 顯示是安全的；其餘錯誤只留 message。
function describeDeliveryError(error: unknown): string {
  if (error instanceof GrammyError) return error.description;
  if (error instanceof Error) return error.message;
  return "unknown delivery error";
}

async function sendOrEdit(
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
  forceNew: boolean,
): Promise<void> {
  const options = buildOptions(message);
  if (!forceNew && message.targetMessageId !== undefined) {
    await deps.api.editMessageText(
      message.chatId,
      Number(message.targetMessageId),
      message.text,
      options,
    );
    return;
  }
  await deps.api.sendMessage(message.chatId, message.text, options);
}

async function handleDeliveryFailure(
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
  error: unknown,
  isResend: boolean,
): Promise<DeliveryResult> {
  const outcome = classifyDeliveryError(error);

  if (outcome.kind === "already-delivered") {
    await deps.repository.markOutboxDelivered(message.messageId, deps.now().toISOString());
    return "delivered";
  }

  if (outcome.kind === "resend-as-new" && !isResend) {
    // 目標訊息不見了：改送新訊息，這次失敗不計入 attempts；
    // 再失敗（isResend = true）才落入下面一般的重試／放棄規則。
    return attemptDelivery(message, deps, true);
  }

  if (outcome.kind === "give-up" || outcome.kind === "resend-as-new") {
    // resend-as-new 若在改送新訊息之後仍然發生，理論上不會出現——這次呼叫的是
    // sendMessage 不是 editMessageText——比照 give-up 處理，避免無窮遞迴。
    // 這個分支目前無法被觸發：故意留著的縱深防禦，不是漏改的死碼；不用花時間找
    // 一條會走到這裡的路徑。
    await deps.repository.markOutboxNeedsAttention(message.messageId, describeDeliveryError(error));
    await deps.onNeedsAttention(message);
    return "needs_attention";
  }

  // outcome.kind === "retry"
  const attempts = message.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await deps.repository.markOutboxNeedsAttention(message.messageId, describeDeliveryError(error));
    await deps.onNeedsAttention(message);
    return "needs_attention";
  }

  const delayMs = outcome.retryAfterMs ?? backoffMs(attempts);
  const nextAttemptAt = new Date(deps.now().getTime() + delayMs).toISOString();
  await deps.repository.markOutboxFailed(
    message.messageId,
    nextAttemptAt,
    describeDeliveryError(error),
  );
  return "retrying";
}

async function attemptDelivery(
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
  isResend: boolean,
): Promise<DeliveryResult> {
  try {
    await sendOrEdit(message, deps, isResend);
  } catch (error) {
    return handleDeliveryFailure(message, deps, error, isResend);
  }
  await deps.repository.markOutboxDelivered(message.messageId, deps.now().toISOString());
  return "delivered";
}

export function deliverOutboxMessage(
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
): Promise<DeliveryResult> {
  return attemptDelivery(message, deps, false);
}

export interface OutboxRunner {
  drainOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createOutboxRunner(deps: OutboxRunnerDependencies): OutboxRunner {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function drainOnce(): Promise<void> {
    const now = deps.now();
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
    // claimDueOutbox 本身同步完成 lease 的指派（只是包了一層 resolved promise），
    // 這裡刻意把它放在第一個 await 之前呼叫：同一行程內兩條路徑同時 drain 同一列時，
    // 後呼叫的那一次會看到 lease 已經被佔用，不會重複遞送。
    const claimed = await deps.repository.claimDueOutbox(
      deps.ownerId,
      now.toISOString(),
      leaseUntil,
      BATCH,
    );
    for (const message of claimed) {
      await deliverOutboxMessage(message, deps);
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void drainOnce();
    }, DRAIN_INTERVAL_MS);
    // 不 unref 的話，這個 timer 會讓行程永遠不結束——測試與
    // LEDGER_STARTUP_CHECK 都會因此掛住。
    timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { drainOnce, start, stop };
}
