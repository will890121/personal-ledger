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

  // 「把值清空」是關掉功能最自然的手勢，而 compose 與 docker run --env-file 都會把
  // `FOO=` 照實傳進容器（兩者都實測過）。少了 src/config.ts 的空字串轉換，
  // 清空一行會讓 bot 直接拒絕啟動，而且「只設一半」那道守衛會對一個根本不是半設定的
  // 狀態開火、訊息還指向另一個變數。三種組合各釘一條。
  it.each([
    ["空字串", ""],
    ["只有空白", "   "],
  ])("兩個都是%s時鏡像關閉，bot 照常啟動", (_name, blank) => {
    const config = loadConfig({
      ...baseEnv,
      GOOGLE_SERVICE_ACCOUNT_KEY_FILE: blank,
      SHEET_SPREADSHEET_ID: blank,
    });

    expect(config.sheets).toBeNull();
    // 其餘設定要完好無損：這條路徑是「鏡像關閉」，不是「設定壞了」。
    expect(config.ownerId).toBe("123");
  });

  it.each([
    [
      "SHEET_SPREADSHEET_ID 空著",
      { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/k.json", SHEET_SPREADSHEET_ID: "" },
      "SHEET_SPREADSHEET_ID is required when GOOGLE_SERVICE_ACCOUNT_KEY_FILE is set",
    ],
    [
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE 空著",
      { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "", SHEET_SPREADSHEET_ID: "s1" },
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required when SHEET_SPREADSHEET_ID is set",
    ],
  ])("一個填了、%s 時仍然拒絕啟動，並指出缺的那一個", (_name, partial, expectedMessage) => {
    // 空字串等同沒設，所以這是真正的半設定，守衛必須照樣開火——而且要指對方向。
    expect(() => {
      loadConfig({ ...baseEnv, ...partial });
    }).toThrow(expectedMessage);
  });

  it("兩個都填了值就啟用鏡像，前後空白會被修掉", () => {
    expect(
      loadConfig({
        ...baseEnv,
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "  /k.json  ",
        SHEET_SPREADSHEET_ID: "  s1  ",
      }).sheets,
    ).toEqual({ keyFile: "/k.json", spreadsheetId: "s1" });
  });

  // M-1（M5c）：原本用交替正規表示式 `/A|B/` 斷言，兩個方向都會過，所以
  // 「缺哪一個變數」沒有被真的釘住——只設了金鑰路徑的使用者可能被告知
  // 「金鑰路徑 is required」，訊息指錯了方向也不會有測試發現。這裡改成
  // 分別斷言各自方向唯一正確的訊息。
  it.each([
    [
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
      { GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/k.json" },
      "SHEET_SPREADSHEET_ID is required when GOOGLE_SERVICE_ACCOUNT_KEY_FILE is set",
    ],
    [
      "SHEET_SPREADSHEET_ID",
      { SHEET_SPREADSHEET_ID: "s1" },
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required when SHEET_SPREADSHEET_ID is set",
    ],
  ])(
    "refuses to start when only %s is set, and names the missing variable (not the one that is set)",
    (_name, partial, expectedMessage) => {
      // Review Focus #5。半開啟狀態下鏡像靜默不運作，使用者不會發現。
      expect(() => {
        loadConfig({ ...baseEnv, ...partial });
      }).toThrow(expectedMessage);
    },
  );

  it("不把 spreadsheet id 寫進錯誤訊息", () => {
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

  it("不把金鑰路徑寫進錯誤訊息", () => {
    // M-2（M5d）：原本只測了 spreadsheet id 那一半，只設金鑰路徑時的路徑洩漏
    // 活了下來。金鑰路徑跟 spreadsheet id 一樣不該出現在終端或日誌裡。
    const act = (): void => {
      loadConfig({ ...baseEnv, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/secret/service-account.json" });
    };

    expect(act).toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY_FILE/);
    try {
      act();
    } catch (error) {
      expect(String(error)).not.toContain("/secret/service-account.json");
    }
  });
});
