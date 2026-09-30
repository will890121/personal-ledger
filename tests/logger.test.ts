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

// 組出一個真正的 GrammyError,而不是隨便捏造一個同名欄位的物件——雖然
// describeError 現在是用鴨子定型（檢查 error_code、description、method 三個
// 欄位的型別）判斷,不是 instanceof,這裡還是用真正的建構子產生測試資料,
// 這樣測試才是在驗證「真正的 GrammyError 會被正確辨識」,而不是隨便湊出
// 一個形狀相符的假物件。logger 之所以不能用 instanceof GrammyError：這個檔案
// 是全專案唯一的日誌出口,src/sheets/ 也要呼叫它記錄錯誤,但不得依賴 grammY，
// 所以只能靠檢查欄位形狀來辨認 Telegram 錯誤。
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
    // 字串裡刻意混入 "_" 和 "-"（真實 token 用的是 base64url 字元集），
    // 而且被這兩個符號截斷後每一段英數字都不到 30 碼——這樣如果哪天有人把
    // 字元類別從 [A-Za-z0-9_-] 誤改窄成 [A-Za-z0-9]，規則會完全比對不到，
    // 完整字串就會被印出來，這個測試才抓得到（Minor 5）。
    logger.error("呼叫失敗", {
      url: "https://api.telegram.org/bot123456789:AAHexampleFakeToken_ForRedactionTestOnly12-End/sendMessage",
    });

    expect(lines.join("\n")).not.toContain("AAHexampleFakeToken_ForRedactionTestOnly12-End");
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

  // Task 12 fix 1：只帶 error_code、description 兩個欄位、沒有 method 的物件
  // 不是 GrammyError——只看這兩個欄位太鬆，任何剛好帶著同名欄位的普通物件都會
  // 被誤判成 Telegram 錯誤，而 description 會被原樣印出，繞過「只有
  // name === 'Error' 才記錄 message」那道安全網。加上 method 之後這個物件要走
  // describeError 的預設分支：不是 Error 實例，只留 UnknownError，description
  // 完全不出現在日誌裡。
  it("does not treat an object with only error_code and description as a Telegram error", () => {
    const { logger, lines } = capture();

    logger.warn("test", {
      error: { error_code: 500, description: "SECRET-FINANCIAL-TEXT-account-12345", name: "X" },
    });

    const output = lines.join("\n");
    expect(output).not.toContain("SECRET-FINANCIAL-TEXT-account-12345");
    expect(output).not.toContain("GrammyError");
  });

  // I4：error 這個鍵名原本是唯一明確跳過遮罩的路徑——describeError 的結果直接寫出去，
  // 沒有再過一次 redactString。它也正是最可能被未來的呼叫端塞進髒東西的鍵名。
  describe("the error key goes through redaction too (I4)", () => {
    const FAKE_TOKEN = "123456789:AAHexampleFakeToken_ForRedactionTestOnly12-End";

    it("redacts a bot token inside a plain Error's message", () => {
      const { logger, lines } = capture();

      logger.error("boom", { error: new Error(`failed calling bot${FAKE_TOKEN}/sendMessage`) });

      const output = lines.join("\n");
      expect(output).not.toContain("AAHexampleFakeToken_ForRedactionTestOnly12-End");
      expect(output).toContain("***");
    });

    it("redacts a bot token inside a GrammyError's description", () => {
      const { logger, lines } = capture();

      logger.error("boom", { error: grammyError(400, `Bad Request: ${FAKE_TOKEN} rejected`) });

      const output = lines.join("\n");
      expect(output).not.toContain("AAHexampleFakeToken_ForRedactionTestOnly12-End");
      expect(output).toContain("***");
    });

    it("never prints the message of an error this project did not throw itself", () => {
      // 財務原文沒有可偵測的值樣式，擋住它的是 describeError 的啟發式：只有本專案
      // 自己以固定字串丟出的 Error（name === "Error"）才連訊息一起記錄，ZodError／
      // SqliteError 之類只留類別名稱。ZodError 會把使用者輸入的實際值回填進 issues
      // 與 message，所以這條路徑必須是裸的類別名稱。
      const error = Object.assign(new Error("invalid input: 午餐 120 統一超商"), {
        name: "ZodError",
      });
      const { logger, lines } = capture();

      logger.error("解析失敗", { error });

      const output = lines.join("\n");
      expect(output).toContain("ZodError");
      expect(output).not.toContain("午餐 120 統一超商");
    });
  });

  // Finding 1：拒絕清單裡的每一個欄位名各自獨立測試——用同一個 Set.has() 實作
  // 不代表每個名字都真的被蓋到；拿掉清單裡任何一個名字，都要有一個測試因此
  // 失敗，而不是只有 rawText 被測到、其他名字形同虛設。
  const DENYLISTED_FIELD_NAMES = [
    "rawText",
    "rawInputSnapshot",
    "text",
    "note",
    "token",
    "telegramBotToken",
    // Sheets 鏡像的四個：試算表 id 與服務帳號金鑰的兩個欄位名。
    "spreadsheetId",
    "serviceAccountKey",
    "privateKey",
    "client_email",
    // M-5：金鑰檔路徑，任何深度都不得原樣印出。
    "keyFile",
  ] as const;

  it.each(DENYLISTED_FIELD_NAMES)("drops the %s field entirely, on its own", (field) => {
    const { logger, lines } = capture();

    logger.error("x", { [field]: "sentinel-value-must-not-appear" });

    expect(lines.join("\n")).not.toContain("sentinel-value-must-not-appear");
  });

  // Finding 2：遮罩必須遞迴。以下三個測試逐字重現 review 回報的三個探測，
  // 都是呼叫端把整包物件（例如 grammY 的 Update）原封不動塞進欄位值，而不是
  // 自己先攤平——這正是「單一出口負責遮罩」要保證的情境。
  describe("recursive redaction (Finding 2)", () => {
    it("drops denylisted field names nested inside an object", () => {
      const { logger, lines } = capture();

      logger.error("x", { update: { message: { text: "午餐 120" } } });

      expect(lines.join("\n")).not.toContain("午餐 120");
    });

    it("redacts a bot-token-shaped value nested inside an object", () => {
      const { logger, lines } = capture();

      logger.error("x", {
        context: {
          url: "https://api.telegram.org/bot123456789:AAHexampleFakeToken_ForRedactionTestOnly12-End/sendMessage",
        },
      });

      const output = lines.join("\n");
      expect(output).not.toContain("AAHexampleFakeToken_ForRedactionTestOnly12-End");
      expect(output).toContain("***");
    });

    it("drops denylisted field names nested inside array elements", () => {
      const { logger, lines } = capture();

      logger.error("x", { drafts: [{ rawText: "午餐 1260" }] });

      expect(lines.join("\n")).not.toContain("午餐 1260");
    });

    it("does not throw on a self-referencing object (cycle guard)", () => {
      const { logger, lines } = capture();
      const cyclic: Record<string, unknown> = { name: "draft" };
      cyclic.self = cyclic;

      expect(() => {
        logger.error("x", { context: cyclic });
      }).not.toThrow();
      expect(lines.join("\n")).toContain("circular reference");
    });
  });

  // Task 12 fix round 2：深度上限（MAX_REDACTION_DEPTH，目前 8）本身沒有測試釘住——
  // 複審把常數從 8 改成 100000 之後，原本 18 條測試照樣全綠。這裡直接咬住
  // src/logger.ts 裡的佔位字串本身，常數改大或那個分支被拿掉都要讓這裡變紅。
  describe("depth cap (Task 12 fix 2)", () => {
    // 用同一個 key 名一路往下包 layers 層，最裡面放一個物件——不是字串。
    // redactValue 對字串一律先做 token 樣式遮罩再回傳，深度檢查那個分支
    // 根本輪不到執行；只有物件（或陣列）才會真的走到深度上限判斷。
    function wrapNested(layers: number, innermost: unknown): unknown {
      let value = innermost;
      for (let i = layers; i >= 1; i -= 1) {
        value = { [`level_${String(i)}`]: value };
      }
      return value;
    }

    it("replaces an object nested past MAX_REDACTION_DEPTH with the placeholder, hiding what's inside it", () => {
      const { logger, lines } = capture();

      // context 這一層算第 1 層，再包 11 層 level_*，最內層的物件落在第 12 層——
      // 遠遠超過目前的上限 8，整包都該換成佔位字串，連裡面的欄位都不該印出來。
      logger.error("x", {
        context: wrapNested(11, { sentinel: "SECRET_BEYOND_DEPTH_CAP" }),
      });

      const output = lines.join("\n");
      expect(output).not.toContain("SECRET_BEYOND_DEPTH_CAP");
      expect(output).toContain("[redacted: max depth reached]");
    });

    it("still recurses normally for an object just inside MAX_REDACTION_DEPTH", () => {
      const { logger, lines } = capture();

      // 同樣的結構只包 7 層，讓最內層的物件剛好落在第 8 層（等於上限本身）——
      // 這一層不該被換成佔位字串，裡面的欄位要照常遞迴處理、正常印出來。
      // 這一條也順便擋住把上限誤設成 0 之類過小的值：那樣的話這裡就會變紅。
      logger.error("x", {
        context: wrapNested(7, { sentinel: "SECRET_WITHIN_DEPTH_CAP" }),
      });

      const output = lines.join("\n");
      expect(output).toContain("SECRET_WITHIN_DEPTH_CAP");
      expect(output).not.toContain("[redacted: max depth reached]");
    });
  });

  // Finding 3 / Minor 4：owner 的識別碼不管記在 ownerId 或 chatId 底下、
  // 不管型別是字串還是數字，都要走同一條雜湊路徑。
  describe("owner-identifying fields (Finding 3, Minor 4)", () => {
    it("hashes chatId the same way as ownerId", () => {
      const { logger, lines } = capture();

      logger.info("x", { chatId: "729367170" });

      expect(lines.join("\n")).not.toContain("729367170");
      expect(lines.join("\n")).toMatch(/[0-9a-f]{8}/);
    });

    it.each(["ownerId", "chatId"] as const)(
      "hashes a numeric %s instead of printing it verbatim",
      (field) => {
        const { logger, lines } = capture();

        logger.info("x", { [field]: 729367170 });

        expect(lines.join("\n")).not.toContain("729367170");
        expect(lines.join("\n")).toMatch(/[0-9a-f]{8}/);
      },
    );
  });
});
