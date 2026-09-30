import { z } from "zod";

/**
 * 帳本變更與「要送給使用者的那一則訊息」在同一個 transaction 裡提交。這個模組只放型別與
 * 純計算：它不認得 SQLite，也不認得 grammY。
 */
export const OutboxCauseSchema = z.enum([
  "transaction_confirmed",
  "recovery_recorded",
  "advance_abandoned",
  "transaction_updated",
  "transaction_deleted",
]);
export type OutboxCause = z.infer<typeof OutboxCauseSchema>;

export type OutboxStatus = "pending" | "delivered" | "needs_attention";

/** 已經渲染好的訊息。telegram 層產生，application 層原樣保存。 */
export interface OutboxPayload {
  readonly chatId: string;
  /** 有值＝編輯這則既有訊息，沒有＝送一則新的。 */
  readonly targetMessageId?: string;
  readonly text: string;
  /** grammY 的 InlineKeyboardMarkup，JSON 字串。 */
  readonly replyMarkup?: string;
}

export interface OutboxMessage extends OutboxPayload {
  readonly messageId: string;
  readonly ownerId: string;
  readonly cause: OutboxCause;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError?: string;
}

/** 從第一次失敗到放棄約 8 分鐘：5s／15s／45s／2m15s／5m。 */
export const MAX_ATTEMPTS = 5;
const BASE_MS = 5_000;
const CAP_MS = 300_000;

/** `attempts` 是「已經失敗過幾次」，第一次失敗傳 1。 */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_MS * 3 ** (attempts - 1), CAP_MS);
}
