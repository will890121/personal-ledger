import { createHash } from "node:crypto";

import { GrammyError } from "grammy";

// 全專案唯一允許呼叫 console.* 的地方（見 eslint.config.mjs 對本檔案開的例外）。
// 其他地方一律呼叫這裡的 info/warn/error，遮罩規則才會真的擋得住東西——
// 只要還有別的出口可以繞過去，禁用 console.* 就沒有意義。

type Level = "info" | "warn" | "error";

// 欄位名只要落在這份清單裡，整個值都丟掉，不管內容是什麼。這些欄位本來就是
// 用來裝使用者原文或機敏憑證的地方，漏放一次進來也不該外洩。
const DENYLISTED_FIELDS: ReadonlySet<string> = new Set([
  "rawText",
  "rawInputSnapshot",
  "text",
  "note",
  "token",
  "telegramBotToken",
]);

// Telegram bot token 的樣式：一串數字、冒號、後面接一長串 base64url 字元。
// 就算 token 沒有被放進上面那份拒絕清單裡的欄位（例如夾在某個 URL 字串裡），
// 這條規則也要能抓到它——欄位名黑名單和值樣式偵測缺一不可。
const BOT_TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

// owner id 要能把同一位使用者的兩筆日誌關聯起來，所以不能整個丟掉；
// 但 id 本身沒有記錄的必要，因此換成雜湊值的前 8 碼。
function hashOwnerId(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 8);
}

function redactString(value: string): string {
  return value.replace(BOT_TOKEN_PATTERN, "***");
}

// 錯誤訊息可能夾帶 SQL 片段（SqliteError）或使用者輸入的財務原文（ZodError 會回填實際值），
// 因此預設只記錄錯誤類別名稱；只有本專案自己以固定字串丟出的 Error 才連訊息一起記錄。
// GrammyError 是例外：error_code 與 description 是 Telegram Bot API 回傳的錯誤描述
// （例如 "Bad Request: message is not modified"），不含使用者輸入或財務資料，
// 記錄它們才診斷得出是哪一種 Telegram 呼叫失敗，而不是只看到一個籠統的類別名稱。
function describeError(error: unknown): {
  readonly name: string;
  readonly message?: string;
  readonly errorCode?: number;
  readonly description?: string;
} {
  if (error instanceof GrammyError) {
    return { name: error.name, errorCode: error.error_code, description: error.description };
  }
  if (!(error instanceof Error)) return { name: "UnknownError" };
  if (error.name === "Error") return { name: error.name, message: error.message };
  return { name: error.name };
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (DENYLISTED_FIELDS.has(key)) continue;
    if (key === "ownerId" && typeof value === "string") {
      redacted[key] = hashOwnerId(value);
      continue;
    }
    if (key === "error") {
      redacted[key] = describeError(value);
      continue;
    }
    redacted[key] = typeof value === "string" ? redactString(value) : value;
  }
  return redacted;
}

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (fields === undefined) {
    console[level](message);
    return;
  }
  console[level](message, redactFields(fields));
}

export const logger = {
  info(message: string, fields?: Record<string, unknown>): void {
    write("info", message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    write("warn", message, fields);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    write("error", message, fields);
  },
};
