/**
 * Sheets 呼叫失敗時的分類：暫時性（下一輪自己會好）還是永久性（不會自己好，
 * 需要有人去處理）。
 *
 * - transient（429/500/502/503/504、逾時等網路錯誤）：游標不推進，下一輪
 *   （20 秒後的 tick）自然重試。不需要佇列，也不需要退避表——tick 本身就是重試。
 * - permanent（400/401/403/404）：不會自己好。403 是「試算表沒分享給服務
 *   帳號」，404 是「試算表被刪」。這兩種如果只是安靜地無限重試，鏡像會停在
 *   那裡、Sheet 不再更新，但一切看起來都正常——這正是本檔案要擋下的情形。
 *
 * 無法判斷狀態碼時一律當 transient：寧可多重試幾輪，也不要因為看到一種
 * 沒預期到的錯誤形狀就誤判成永久、把鏡像整個停下來。
 */
export type SheetFailureKind = "transient" | "permanent";

/** 連續失敗達到這個次數就升級成使用者看得到的通知。 */
export const ESCALATE_AFTER_FAILURES = 5;

const PERMANENT_STATUS_CODES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

/**
 * 從 googleapis 風格的錯誤物件取狀態碼。可能長在 `code`（數字，googleapis 常見
 * 位置）或 `response.status`（底層 HTTP client 常見位置）；兩個都取不到就是
 * 沒有可判斷的狀態碼。
 *
 * 刻意不 import googleapis 的型別：src/sheets/ 不能依賴 googleapis（AC 邊界），
 * 這裡只用鴨子定型讀欄位。
 */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const withCode = error as { code?: unknown; response?: unknown };
  if (typeof withCode.code === "number") return withCode.code;
  if (typeof withCode.response === "object" && withCode.response !== null) {
    const status = (withCode.response as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

export function classifySheetFailure(error: unknown): SheetFailureKind {
  const status = statusCodeOf(error);
  if (status !== undefined && PERMANENT_STATUS_CODES.has(status)) return "permanent";
  return "transient";
}

/**
 * `lastError` 要存的內容：只有分類與狀態碼，不含錯誤訊息本文。
 *
 * Google 的錯誤訊息可能夾帶試算表 id，本專案禁止把它寫進任何持久化欄位或
 * 日誌（AC 邊界）。分類加狀態碼已經足夠讓人判斷「要不要去處理」，不需要
 * 原始訊息。
 */
export function describeSheetFailure(error: unknown): string {
  const kind = classifySheetFailure(error);
  const status = statusCodeOf(error);
  return status === undefined ? `${kind}:unknown` : `${kind}:${String(status)}`;
}
