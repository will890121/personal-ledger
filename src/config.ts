import { z } from "zod";

const DEFAULT_DATABASE_PATH = "./data/personal-ledger.sqlite";
const DEFAULT_TIMEZONE = "Asia/Taipei";
const DEFAULT_CURRENCY = "TWD";

/**
 * 「有這個鍵、但值是空字串」一律當成沒設定。
 *
 * 把功能關掉最自然的手勢就是把那一行的值清空，而 compose 與
 * `docker run --env-file` 都會把 `FOO=` 照實傳進容器（兩者都實測過），
 * 於是變數在程式看來是「有設定、值不合法」。少了這個轉換，清空一行會讓 bot
 * 直接拒絕啟動 —— 而且「只設一半就拒絕啟動」那道守衛會對一個根本不是半設定的
 * 狀態開火，錯誤訊息還會指向另一個變數。開機失敗很吵，但吵錯方向比不吵更糟。
 *
 * 只吃掉「整個值是空白」這一種情形。真的填了值就照原樣驗證，所以半設定
 * （一個填了、一個空著或沒有）仍然會拒絕啟動。
 */
const optionalTrimmed = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, "TELEGRAM_BOT_TOKEN is required"),
  LEDGER_OWNER_ID: z.string().regex(/^\d+$/, "LEDGER_OWNER_ID must be numeric"),
  DATABASE_PATH: z.string().trim().min(1).default(DEFAULT_DATABASE_PATH),
  TZ: z.string().trim().min(1).default(DEFAULT_TIMEZONE),
  LEDGER_CURRENCY: z.literal(DEFAULT_CURRENCY).default(DEFAULT_CURRENCY),
  // 兩個都選填：都沒設代表「這台機器還沒有 Sheets 憑證」，鏡像整個關閉、bot 照常運作。
  // 空字串等同沒設（見 optionalTrimmed）：把值清空是關掉功能最自然的手勢。
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: optionalTrimmed,
  SHEET_SPREADSHEET_ID: optionalTrimmed,
});

/** Sheets 鏡像的設定。`null` 代表鏡像整個關閉。 */
export interface SheetsMirrorConfig {
  readonly keyFile: string;
  readonly spreadsheetId: string;
}

export interface AppConfig {
  readonly telegramBotToken: string;
  readonly ownerId: string;
  readonly databasePath: string;
  readonly timezone: typeof DEFAULT_TIMEZONE;
  readonly currency: typeof DEFAULT_CURRENCY;
  readonly sheets: SheetsMirrorConfig | null;
}

const KEY_FILE_VARIABLE = "GOOGLE_SERVICE_ACCOUNT_KEY_FILE";
const SPREADSHEET_ID_VARIABLE = "SHEET_SPREADSHEET_ID";

/**
 * 兩個變數是一組的：兩個都有才開啟鏡像，兩個都沒有才算關閉。
 *
 * 只設了一半就拒絕啟動，而不是靜默地當成關閉。半開啟狀態下鏡像什麼都不做，
 * 可是設定檔裡明明有一個 Sheets 變數——使用者會以為鏡像在跑，而且沒有任何訊號
 * 會告訴他不是。啟動失敗很吵，但吵的東西五秒內就會被發現。
 *
 * 錯誤訊息只講變數名稱，絕不回帶值：spreadsheet id 與金鑰路徑都不該出現在
 * 日誌或終端輸出裡。
 */
function resolveSheetsConfig(
  keyFile: string | undefined,
  spreadsheetId: string | undefined,
): SheetsMirrorConfig | null {
  if (keyFile !== undefined && spreadsheetId !== undefined) return { keyFile, spreadsheetId };
  if (keyFile === undefined && spreadsheetId === undefined) return null;
  const missing = keyFile === undefined ? KEY_FILE_VARIABLE : SPREADSHEET_ID_VARIABLE;
  const present = keyFile === undefined ? SPREADSHEET_ID_VARIABLE : KEY_FILE_VARIABLE;
  throw new Error(
    `Invalid configuration: ${missing} is required when ${present} is set ` +
      `(set both to enable the Sheets mirror, or neither to disable it)`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .filter((field) => field.length > 0);
    const uniqueFields = Array.from(new Set(fields));
    throw new Error(`Invalid configuration: ${uniqueFields.join(", ")}`);
  }

  return {
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    ownerId: parsed.data.LEDGER_OWNER_ID,
    databasePath: parsed.data.DATABASE_PATH,
    timezone: DEFAULT_TIMEZONE,
    currency: DEFAULT_CURRENCY,
    sheets: resolveSheetsConfig(
      parsed.data.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      parsed.data.SHEET_SPREADSHEET_ID,
    ),
  };
}
