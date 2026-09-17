import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("缺少 Telegram token 時拒絕啟動", () => {
    expect(() => loadConfig({ LEDGER_OWNER_ID: "123" })).toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("載入第一階段預設值", () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: "test-token",
        LEDGER_OWNER_ID: "123",
      }),
    ).toMatchObject({
      ownerId: "123",
      databasePath: "./data/personal-ledger.sqlite",
      timezone: "Asia/Taipei",
      currency: "TWD",
    });
  });

  it("拒絕非數字 owner ID 且不輸出 token 值", () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "secret-token-value",
        LEDGER_OWNER_ID: "not-a-number",
      }),
    ).toThrow(/LEDGER_OWNER_ID/);

    try {
      loadConfig({
        TELEGRAM_BOT_TOKEN: "secret-token-value",
        LEDGER_OWNER_ID: "not-a-number",
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-token-value");
    }
  });
});
