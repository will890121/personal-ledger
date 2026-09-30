import { GrammyError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import { MAX_ATTEMPTS, backoffMs, type OutboxMessage } from "../domain/outbox.js";
import { logger } from "../logger.js";
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
 * 寧可重複也不要遺失。
 *
 * 重複的界線到底是什麼，講清楚（這裡曾經寫著「lease 的長度就是這個重複的上限」，
 * 那是一句沒有人在檢查的斷言，而且不成立）：
 *
 *   - **一次送出**有界：每個 API 呼叫都帶 SEND_TIMEOUT_MS 的 AbortSignal，
 *     且 SEND_TIMEOUT_MS 必須始終小於 LEASE_MS（見下面那個常數的說明）。
 *   - **一列不是嚴格有界**：一次 drain 用**同一個** leaseUntil 一口氣 claim 最多
 *     BATCH 列，然後循序送出。排在批次後段的列，lease 可能在輪到它送的途中就過期，
 *     於是被下一輪 drain 重新 claim——同一列因此仍可能有第二次併發送出。
 *     實測（3 列卡住）：每列 2 次併發；在加上 SEND_TIMEOUT_MS 之前是 6 次。
 *   - **資料狀態不受影響**：遲到的 worker 手上是過期的 lease 值，三個 markOutbox*
 *     的 compare-and-set 會擋掉它的寫入，告警也一併被擋（見 notifyIfOwned）。
 *     會被使用者看見的只有「同一則訊息送兩次」，而且僅限沒有 targetMessageId 的
 *     訊息——有 target 的重複會被 Telegram 用 message is not modified 擋掉，
 *     delivery-error.ts 正確地把它當成已送達。
 *
 * 要讓「一列」也嚴格有界，得在每一列送出前重新續租（連 lease token 一起更新），
 * 那是對並發核心的設計變更，不是註解能解決的事：見 docs/todo/outbox-per-row-lease.md。
 */

export const LEASE_MS = 30_000;
const BATCH = 10;
export const DRAIN_INTERVAL_MS = 5_000;

/**
 * 每一次送出呼叫自己的逾時。**必須始終小於 LEASE_MS**：上面「一次送出有界」那一條
 * 就是這個關係本身，一旦反過來，那一條也跟著失效。
 *
 * 少了它，卡住的 HTTP 呼叫會用 grammY 的預設 500 秒逾時，也就是比 lease 多活 470 秒：
 * 期間每一輪 drain（5 秒一次）都會在 lease 過期後重新 claim 同一列再送一次，
 * 同一則訊息因此可以同時有六個 in-flight 的送出。lease 限制的是重複的速率，不是次數。
 *
 * 刻意不去改 grammY client 的全域 timeoutSeconds：那會一併套用到 getUpdates 長輪詢。
 * 逾時被中止的送出會走既有的失敗路徑（退避重試），這正是我們要的行為。
 */
export const SEND_TIMEOUT_MS = 20_000;

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
    signal: AbortSignal,
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: OutboxSendOptions,
    signal: AbortSignal,
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
  // 每一次呼叫各自一個 signal：一次 sendOrEdit 最多走一條分支，但 resend-as-new
  // 會再進來一次，逾時計時必須從那一次呼叫重新起算，不是整列共用一個。
  const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
  if (!forceNew && message.targetMessageId !== undefined) {
    await deps.api.editMessageText(
      message.chatId,
      Number(message.targetMessageId),
      message.text,
      options,
      signal,
    );
    return;
  }
  await deps.api.sendMessage(message.chatId, message.text, options, signal);
}

/**
 * 三個 markOutbox* 都是 compare-and-set，寫不進去時回傳 false。這不是錯誤：代表
 * 這一列在我們送出的期間 lease 已經過期、被另一個 worker 接手並且已經有了結果
 * （markOutboxDelivered 會把 lease_expires_at 清成 NULL，所以遲到的 worker 之後
 * 一定對不上）。記一行然後正常繼續；硬蓋回去才是真正的災難——訊息其實已經送到，
 * /status 卻會顯示「待處理 1 筆 ⚠️」並發告警，按「重試全部」還會真的再送一次。
 *
 * 回傳「這次寫入有沒有落地」，也就是「我還是不是這一列的擁有者」。呼叫端必須用它
 * 來決定要不要做**對外可見的副作用**：CAS 只擋得住資料庫那一半，擋不住已經送出去的
 * 告警。見 notifyIfOwned。
 */
function recordOutcome(messageId: string, write: Promise<boolean>): Promise<boolean> {
  return write.then((applied) => {
    if (!applied) {
      logger.info("outbox row already had a newer result; not overwriting it", { messageId });
    }
    return applied;
  });
}

/**
 * 只有真正寫下 needs_attention 的那個 worker 才發告警。
 *
 * 少了這道閘門，過期的 worker 會對一列**已經 delivered** 的訊息推播
 * 「有訊息送不出去……用 /status 查看並重試」，而 /status 正確地顯示一切正常——
 * 一個自相矛盾的假警報，比修掉 CAS 之前那個「錯得一致」的狀態更讓人困惑，
 * 而且它是我們自己加上去的。
 */
async function notifyIfOwned(
  owned: boolean,
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
): Promise<void> {
  if (!owned) return;
  await deps.onNeedsAttention(message);
}

async function handleDeliveryFailure(
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
  error: unknown,
  isResend: boolean,
  leaseToken: string,
): Promise<DeliveryResult> {
  const outcome = classifyDeliveryError(error);

  if (outcome.kind === "already-delivered") {
    await recordOutcome(
      message.messageId,
      deps.repository.markOutboxDelivered(message.messageId, deps.now().toISOString(), leaseToken),
    );
    return "delivered";
  }

  if (outcome.kind === "resend-as-new" && !isResend) {
    // 目標訊息不見了：改送新訊息，這次失敗不計入 attempts；
    // 再失敗（isResend = true）才落入下面一般的重試／放棄規則。
    return attemptDelivery(message, deps, true, leaseToken);
  }

  if (outcome.kind === "give-up" || outcome.kind === "resend-as-new") {
    // resend-as-new 若在改送新訊息之後仍然發生，理論上不會出現——這次呼叫的是
    // sendMessage 不是 editMessageText——比照 give-up 處理，避免無窮遞迴。
    // 這個分支目前無法被觸發：故意留著的縱深防禦，不是漏改的死碼；不用花時間找
    // 一條會走到這裡的路徑。
    const owned = await recordOutcome(
      message.messageId,
      deps.repository.markOutboxNeedsAttention(
        message.messageId,
        describeDeliveryError(error),
        leaseToken,
      ),
    );
    logger.warn("outbox delivery abandoned; moved to needs_attention", {
      messageId: message.messageId,
      attempts: message.attempts,
      error,
    });
    await notifyIfOwned(owned, message, deps);
    return "needs_attention";
  }

  // outcome.kind === "retry"
  const attempts = message.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    const owned = await recordOutcome(
      message.messageId,
      deps.repository.markOutboxNeedsAttention(
        message.messageId,
        describeDeliveryError(error),
        leaseToken,
      ),
    );
    logger.warn("outbox exhausted its retry cap; moved to needs_attention", {
      messageId: message.messageId,
      attempts,
      error,
    });
    await notifyIfOwned(owned, message, deps);
    return "needs_attention";
  }

  const delayMs = outcome.retryAfterMs ?? backoffMs(attempts);
  const nextAttemptAt = new Date(deps.now().getTime() + delayMs).toISOString();
  await recordOutcome(
    message.messageId,
    deps.repository.markOutboxFailed(
      message.messageId,
      nextAttemptAt,
      describeDeliveryError(error),
      leaseToken,
    ),
  );
  logger.info("outbox delivery failed; backoff scheduled", {
    messageId: message.messageId,
    attempts,
    delayMs,
    error,
  });
  return "retrying";
}

async function attemptDelivery(
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
  isResend: boolean,
  leaseToken: string,
): Promise<DeliveryResult> {
  try {
    await sendOrEdit(message, deps, isResend);
  } catch (error) {
    return handleDeliveryFailure(message, deps, error, isResend, leaseToken);
  }
  await recordOutcome(
    message.messageId,
    deps.repository.markOutboxDelivered(message.messageId, deps.now().toISOString(), leaseToken),
  );
  return "delivered";
}

/**
 * leaseToken 就是 claim 這一列時寫進 lease_expires_at 的那個值：這一次遞送的
 * 「我還是這一列的擁有者嗎」憑證。呼叫端必須把 claim 當下的值原封不動傳進來。
 */
export function deliverOutboxMessage(
  message: OutboxMessage,
  deps: OutboxRunnerDependencies,
  leaseToken: string,
): Promise<DeliveryResult> {
  return attemptDelivery(message, deps, false, leaseToken);
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
      // leaseUntil 是這一批共用的 lease 值，也就是 markOutbox* 的樂觀鎖版本值。
      await deliverOutboxMessage(message, deps, leaseUntil);
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      // drainOnce() 真的會 reject：claimDueOutbox、三個 markOutbox*、onNeedsAttention
      // 都在 try 之外。Node 24 預設 --unhandled-rejections=throw，少了這個 .catch()，
      // 一次 SQLite I/O 錯誤就會直接殺掉整個行程，而 compose.yaml 是
      // restart: unless-stopped——每 5 秒死一次的無盡 crash loop。記一行就好，
      // 不 rethrow：下一輪 drain 會用平常的規則重新撈到同一列。
      drainOnce().catch((error: unknown) => {
        logger.error("outbox drain failed", { error });
      });
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
