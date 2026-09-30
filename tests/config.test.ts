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

describe("loadConfig 的 Sheets 鏡像設定", () => {
  const baseEnv = { TELEGRAM_BOT_TOKEN: "test-token", LEDGER_OWNER_ID: "123" };

  it("leaves the sheets mirror off when neither variable is set", () => {
    expect(loadConfig(baseEnv).sheets).toBeNull();
  });

  it("enables the mirror when both are set", () => {
    expect(
      loadConfig({
        ...baseEnv,
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/k.json",
        SHEET_SPREADSHEET_ID: "s1",
      }).sheets,
    ).toEqual({ keyFile: "/k.json", spreadsheetId: "s1" });
  });

  it.each([
    ["GOOGLE_SERVICE_ACCOUNT_KEY_FILE", { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/k.json" }],
    ["SHEET_SPREADSHEET_ID", { SHEET_SPREADSHEET_ID: "s1" }],
  ])("refuses to start when only %s is set", (_name, partial) => {
    // Review Focus #5。半開啟狀態下鏡像靜默不運作，使用者不會發現。
    expect(() => {
      loadConfig({ ...baseEnv, ...partial });
    }).toThrow(/SHEET_SPREADSHEET_ID|GOOGLE_SERVICE_ACCOUNT_KEY_FILE/);
  });

  it("不把 spreadsheet id 或金鑰路徑寫進錯誤訊息", () => {
    // 錯誤訊息會進終端與日誌。只設一半時它一定會被印出來，所以只能提變數名稱。
    const act = (): void => {
      loadConfig({ ...baseEnv, SHEET_SPREADSHEET_ID: "secret-spreadsheet-id" });
    };

    expect(act).toThrow(/SHEET_SPREADSHEET_ID/);
    try {
      act();
    } catch (error) {
      expect(String(error)).not.toContain("secret-spreadsheet-id");
    }
  });
});
