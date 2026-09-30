import type { SheetSyncState } from "../ports/sheet-sync-repository.js";

/**
 * 「Sheets 鏡像連續失敗」升級成使用者看得到的通知。
 *
 * Task 8 只定義了注入點（`createSheetMirror` 的 `onNeedsAttention`），真正送出
 * 通知是在這裡接的。形狀沿用 `src/telegram/notify-attention.ts` 裁決過的語意：
 *   - 盡力而為的直接發送，不排進 outbox：outbox 是給「記好的帳要通知使用者」用的，
 *     一則「鏡像壞了」的告警不值得在管道故障時生出一批永遠送不出去的列。
 *   - 節流鍵只在送出成功時才寫入。這件事由呼叫端（`sheet-mirror.ts`）負責：它只在
 *     `onNeedsAttention` 沒有拋錯時才 `saveAlertAt`。所以這裡送不出去**必須**把錯誤
 *     往外拋，不能自己吞掉——吞掉就等於謊報成功，使用者接下來十分鐘完全收不到
 *     任何告警，而他其實一則都還沒收到。記一行是我們的事，吞不吞是呼叫端的事。
 *
 * 不 import grammY（`src/sheets/` 的邊界），只要一個能送訊息的東西；
 * 也不 import `src/logger.ts`（它 import 了 grammY），改用注入的 logError。
 */

/** 刻意收窄：告警一律送新訊息，用不到 editMessageText。 */
export interface SheetsAttentionApi {
  sendMessage(chatId: string, text: string): Promise<unknown>;
}

export interface SheetsAttentionNotifierDependencies {
  /** 只服務一位使用者，chat id 就是 owner id。 */
  readonly chatId: string;
  readonly api: SheetsAttentionApi;
  readonly logError: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * 訊息內容。
 *
 * **不得帶入錯誤原文**：Google 的錯誤訊息可能回帶試算表 id，而這則訊息會進
 * Telegram 的聊天記錄。`state.lastError` 例外——它是 `describeSheetFailure` 產出的
 * `"permanent:403"` 這種「分類:狀態碼」字串，本來就只有這兩個資訊。403 幾乎一定是
 * 「試算表沒再分享給服務帳號」，所以提示文字直接講那件事。
 */
export function sheetsAttentionText(state: SheetSyncState): string {
  const detail = state.lastError === null ? "" : `\n錯誤類別：${state.lastError}`;
  return (
    "⚠️ Sheets 鏡像連續失敗\n" +
    "帳都記在資料庫裡，只是試算表暫時沒有更新。請確認試算表仍分享給服務帳號。" +
    `${detail}\n用 /status 查看目前狀態。`
  );
}

export function createSheetsAttentionNotifier(
  deps: SheetsAttentionNotifierDependencies,
): (state: SheetSyncState) => Promise<void> {
  return async (state: SheetSyncState): Promise<void> => {
    try {
      await deps.api.sendMessage(deps.chatId, sheetsAttentionText(state));
    } catch (error) {
      // 記一行就好：呼叫端會吞掉這個錯誤（同步不能因為通知失敗而整輪失敗），
      // 但一定要往外拋，節流時間戳才不會在什麼都沒送出的情況下被蓋掉。
      deps.logError("sheet mirror attention alert could not be sent", { error });
      throw error;
    }
  };
}
