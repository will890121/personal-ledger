import { GrammyError } from "grammy";

/**
 * 遞送失敗分成四類，因為它們該做的事完全不同：
 *
 * - `already-delivered`：內容相同、訊息已經在那裡，不是失敗。
 * - `resend-as-new`：要編輯的訊息不見了（重啟後常見），改送新訊息且不計入失敗次數。
 * - `give-up`：重試一百次也一樣（被封鎖、聊天室不存在、訊息太長），直接 needs_attention。
 * - `retry`：其餘一律退避重試；429 帶 `retry_after` 時遵守它，不套用自己的退避。
 */
export type DeliveryOutcome =
  | { readonly kind: "retry"; readonly retryAfterMs?: number }
  | { readonly kind: "give-up"; readonly reason: string }
  | { readonly kind: "already-delivered" }
  | { readonly kind: "resend-as-new" };

export function classifyDeliveryError(error: unknown): DeliveryOutcome {
  if (!(error instanceof GrammyError)) return { kind: "retry" };

  const description = error.description.toLowerCase();

  if (description.includes("message is not modified")) return { kind: "already-delivered" };
  if (
    description.includes("message to edit not found") ||
    description.includes("message can't be edited") ||
    description.includes("message to be edited not found")
  ) {
    return { kind: "resend-as-new" };
  }

  if (error.error_code === 429) {
    const retryAfter = error.parameters.retry_after;
    return retryAfter === undefined
      ? { kind: "retry" }
      : { kind: "retry", retryAfterMs: retryAfter * 1_000 };
  }

  if (error.error_code === 403) return { kind: "give-up", reason: "blocked" };
  if (description.includes("chat not found")) return { kind: "give-up", reason: "chat_not_found" };
  if (description.includes("message is too long")) {
    return { kind: "give-up", reason: "message_too_long" };
  }

  return { kind: "retry" };
}
