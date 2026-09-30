import { createHash } from "node:crypto";

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
  // Sheets 鏡像帶進來的四個：試算表 id 本身就是通往整份財務資料的位址（知道 id
  // 再加上一份洩漏的金鑰就等於整本帳），服務帳號金鑰檔的內容（privateKey、
  // client_email）是憑證本體，而 googleapis 的錯誤物件很容易被整包塞進日誌欄位。
  "spreadsheetId",
  "serviceAccountKey",
  "privateKey",
  "client_email",
  // M-5：金鑰檔的路徑。spreadsheetId 巢狀出現一樣會被遮，但 keyFile 原本不會——
  // 而金鑰路徑跟 spreadsheetId 一樣在「正式日誌不得含」的清單裡。
  "keyFile",
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

// grammY 的 GrammyError 實際欄位：method、payload、ok、name、error_code、
// description、parameters。用鴨子定型判斷而不是 `instanceof GrammyError`——
// 這個檔案是全專案唯一的日誌出口，import grammY 只為了認出一種錯誤形狀，會讓
// 不該依賴 grammY 的地方（例如 src/sheets/）也沒辦法呼叫這裡（見本檔案的邊界
// 說明）。只看欄位的形狀，不看建構子，就不必知道 grammY 存在。
//
// 只檢查 error_code、description 兩個欄位太鬆：一個普通物件只要剛好帶著同名
// 欄位就會被誤判成 Telegram 錯誤，而 description 會被 describeError 原樣印出——
// 繞過「只有 name === 'Error' 才記錄 message」那道安全網。因此再加上 method
// （字串），並且三個欄位都檢查型別而不是只檢查存在：一個隨機物件同時帶著
// error_code（number）、description（string）、method（string）三者的機率
// 極低，真正的 GrammyError 一定三者俱全。
function isTelegramApiError(error: unknown): error is {
  readonly error_code: number;
  readonly description: string;
  readonly method: string;
} {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { error_code?: unknown; description?: unknown; method?: unknown };
  return (
    typeof candidate.error_code === "number" &&
    typeof candidate.description === "string" &&
    typeof candidate.method === "string"
  );
}

// 錯誤訊息可能夾帶 SQL 片段（SqliteError）或使用者輸入的財務原文（ZodError 會回填實際值），
// 因此預設只記錄錯誤類別名稱；只有本專案自己以固定字串丟出的 Error 才連訊息一起記錄。
// Telegram API 錯誤是例外：error_code 與 description 是 Bot API 回傳的錯誤描述
// （例如 "Bad Request: message is not modified"），不含使用者輸入或財務資料，
// 記錄它們才診斷得出是哪一種 Telegram 呼叫失敗，而不是只看到一個籠統的類別名稱。
function describeError(error: unknown): {
  readonly name: string;
  readonly message?: string;
  readonly errorCode?: number;
  readonly description?: string;
} {
  if (isTelegramApiError(error)) {
    return { name: "GrammyError", errorCode: error.error_code, description: error.description };
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
      // describeError 的結果要再走一次一般的字串遮罩：它挑出來的 message／
      // description 一樣可能夾帶 bot token（例如 grammY 把請求 URL 放進訊息裡）。
      // 「單一出口負責遮罩」的意思就是連這條捷徑也不能跳過遮罩——error 正是最可能
      // 被未來的呼叫端塞進髒東西的鍵名。
      redacted[key] = redactValue(describeError(value), depth + 1, ancestors);
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
