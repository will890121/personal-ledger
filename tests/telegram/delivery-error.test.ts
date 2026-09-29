import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";

import { classifyDeliveryError } from "../../src/telegram/delivery-error.js";

function grammyError(errorCode: number, description: string, parameters = {}): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: errorCode, description, parameters },
    "sendMessage",
    {},
  );
}

describe("classifyDeliveryError", () => {
  it("treats an unchanged message as already delivered", () => {
    // 內容相同代表訊息已經在那裡了，這不是失敗。
    expect(classifyDeliveryError(grammyError(400, "Bad Request: message is not modified"))).toEqual(
      { kind: "already-delivered" },
    );
  });

  it("falls back to a new message when the target is gone", () => {
    // 重啟後原訊息可能已被刪除；改送新訊息，不計入失敗次數。
    expect(
      classifyDeliveryError(grammyError(400, "Bad Request: message to edit not found")),
    ).toEqual({ kind: "resend-as-new" });
    expect(classifyDeliveryError(grammyError(400, "Bad Request: message can't be edited"))).toEqual(
      { kind: "resend-as-new" },
    );
  });

  it("honours retry_after instead of its own backoff", () => {
    expect(
      classifyDeliveryError(
        grammyError(429, "Too Many Requests: retry after 12", { retry_after: 12 }),
      ),
    ).toEqual({ kind: "retry", retryAfterMs: 12_000 });
  });

  it("gives up on errors that retrying cannot fix", () => {
    // 被封鎖、聊天室不存在，重試一百次也一樣。訊息太長同理——那是內容問題不是網路問題。
    expect(
      classifyDeliveryError(grammyError(403, "Forbidden: bot was blocked by the user")),
    ).toEqual({ kind: "give-up", reason: "blocked" });
    expect(classifyDeliveryError(grammyError(400, "Bad Request: chat not found"))).toEqual({
      kind: "give-up",
      reason: "chat_not_found",
    });
    expect(classifyDeliveryError(grammyError(400, "Bad Request: message is too long"))).toEqual({
      kind: "give-up",
      reason: "message_too_long",
    });
  });

  it("retries a server error or a plain network failure", () => {
    expect(classifyDeliveryError(grammyError(502, "Bad Gateway"))).toEqual({ kind: "retry" });
    expect(classifyDeliveryError(new Error("fetch failed"))).toEqual({ kind: "retry" });
  });
});
