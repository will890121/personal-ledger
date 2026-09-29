import { GrammyError } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/logger.js";

// 把 console.info/warn/error 攔下來,轉成一串好比對的字串。這裡刻意不呼叫
// console.*,只是把它當成 vi.spyOn 的目標物件——不會觸發 no-console。
function capture(): { logger: typeof logger; lines: string[] } {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  vi.spyOn(console, "info").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  return { logger, lines };
}

// 組出一個真正的 GrammyError,而不是隨便捏造一個同名欄位的物件——
// describeError 是用 instanceof GrammyError 判斷,不是看欄位長相。
function grammyError(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: errorCode, description },
    "sendMessage",
    {},
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("never prints the bot token", () => {
    const { logger, lines } = capture();

    // brief 裡示範用的 "AAExampleToken" 只有 14 碼,比 token 樣式規則要求的
    // 30 碼還短,套用規則根本不會命中;這裡改用長度貼近真實 bot token
    // （Telegram 的祕密部分實際上是 35 碼）的假字串,才是名副其實的測試。
    logger.error("呼叫失敗", {
      url: "https://api.telegram.org/bot123456789:AAHexampleFakeBotTokenForRedactionTest12/sendMessage",
    });

    expect(lines.join("\n")).not.toContain("AAHexampleFakeBotTokenForRedactionTest12");
    expect(lines.join("\n")).toContain("***");
  });

  it("prints a short hash instead of the owner id", () => {
    const { logger, lines } = capture();

    logger.info("啟動", { ownerId: "729367170" });

    expect(lines.join("\n")).not.toContain("729367170");
    expect(lines.join("\n")).toMatch(/[0-9a-f]{8}/);
  });

  it("drops fields that carry financial text", () => {
    // 交易原文、訊息內容都不進日誌；要關聯就用 draft_ref 或 message_id。
    const { logger, lines } = capture();

    logger.error("解析失敗", { rawText: "午餐 1260，小明欠 630", draftRef: "a1b2c3d4" });

    expect(lines.join("\n")).not.toContain("午餐");
    expect(lines.join("\n")).not.toContain("1260");
    expect(lines.join("\n")).toContain("a1b2c3d4");
  });

  it("reduces a SQLite error to its class", () => {
    const error = Object.assign(new Error("UNIQUE constraint failed: transactions.request_id"), {
      name: "SqliteError",
    });
    const { logger, lines } = capture();

    logger.error("寫入失敗", { error });

    expect(lines.join("\n")).toContain("SqliteError");
    expect(lines.join("\n")).not.toContain("request_id");
  });

  it("keeps a Telegram error's code and description", () => {
    // 這兩個欄位是 Bot API 的錯誤描述，不含使用者輸入，少了它們就診斷不出是哪一種呼叫失敗。
    const { logger, lines } = capture();

    logger.error("遞送失敗", { error: grammyError(400, "Bad Request: message is not modified") });

    expect(lines.join("\n")).toContain("message is not modified");
  });
});
