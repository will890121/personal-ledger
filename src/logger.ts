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

// Telegram bot token 的樣式：一串數字、冒號、後面接一長串 base64url 字元
// （真正的 token 祕密部分是 35 碼，且會用到 "_" 和 "-"，不是單純英數字）。
// 就算 token 沒有被放進上面那份拒絕清單裡的欄位（例如夾在某個 URL 字串裡），
// 這條規則也要能抓到它——欄位名黑名單和值樣式偵測缺一不可。
const BOT_TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

// 這個 bot 只服務一個白名單使用者、且只在私訊裡運作，所以「聊天室 id」跟
// 「使用者 id」是同一個數字——只認 ownerId 這個鍵名的話，任何以 chatId 之類
// 別的鍵名記錄同一個 id 的呼叫端都會把它原封不動印出來。約定：任何代表
// owner 身分的值都要記在這兩個鍵名之一，這裡才會把它雜湊。
const OWNER_IDENTIFYING_FIELDS: ReadonlySet<string> = new Set(["ownerId", "chatId"]);

// 遞迴深度上限：grammY 的 Update 物件實際巢狀深度通常不到 5 層，這裡抓 8 層
// 留一點餘裕，同時擋住刻意或意外做出來的超深物件把呼叫堆疊耗光。超過上限的
// 分支不再往下看，直接換成一個明確的佔位字串，而不是原樣印出來。
const MAX_REDACTION_DEPTH = 8;

// owner id／chat id 要能把同一位使用者的兩筆日誌關聯起來，所以不能整個丟掉；
// 但 id 本身沒有記錄的必要，因此換成雜湊值的前 8 碼。型別可能是字串也可能是
// 數字（例如 grammY 的 chat.id 是 number），一律先轉成字串再雜湊。
function hashOwnerIdentifier(value: string | number): string {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
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

// 「單一出口負責遮罩」的意義，就在於呼叫端不必自己先把物件攤平成一份安全的
// 子集。只處理頂層欄位的話，這個保證只在「每個未來的呼叫端都記得先攤平」時
// 成立——而 grammY 的 Update 物件天生深度巢狀，`{ update: ctx.update }` 正是
// 日後有人除錯 handler 時最可能順手寫下的一行，因此欄位名黑名單、owner id
// 雜湊、bot token 樣式偵測都要在每一層都重新套用一次，不只套在最外層。
//
// ancestors 記錄「目前這條路徑上」已經走過的物件／陣列（進入時加入、離開時
// 移除），只用來擋真正的循環參照；同一個物件被兩個不同分支各自引用一次
// （非循環）不會被誤判。
function redactValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_REDACTION_DEPTH) return "[redacted: max depth reached]";
  if (ancestors.has(value)) return "[redacted: circular reference]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, ancestors));
    }
    return redactObjectFields(value as Record<string, unknown>, depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function redactObjectFields(
  fields: Record<string, unknown>,
  depth: number,
  ancestors: Set<object>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (DENYLISTED_FIELDS.has(key)) continue;
    if (
      OWNER_IDENTIFYING_FIELDS.has(key) &&
      (typeof value === "string" || typeof value === "number")
    ) {
      redacted[key] = hashOwnerIdentifier(value);
      continue;
    }
    if (key === "error") {
      redacted[key] = describeError(value);
      continue;
    }
    redacted[key] = redactValue(value, depth + 1, ancestors);
  }
  return redacted;
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactObjectFields(fields, 0, new Set());
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
