import { describe, expect, it, vi } from "vitest";

import type { SheetSyncState } from "../../src/ports/sheet-sync-repository.js";
import {
  createSheetsAttentionNotifier,
  sheetsAttentionText,
} from "../../src/sheets/notify-sheets-attention.js";

const OWNER = "owner-1";

function failedState(lastError: string | null): SheetSyncState {
  return {
    ownerId: OWNER,
    cursorUpdatedAt: null,
    cursorTransactionId: null,
    lastSuccessAt: null,
    lastError,
    consecutiveFailures: 5,
    lastReconciledAt: null,
  };
}

describe("Sheets 鏡像的告警訊息", () => {
  it("告訴使用者去檢查分享設定，並指向 /status", () => {
    const text = sheetsAttentionText(failedState("permanent:403"));

    expect(text).toContain("Sheets 鏡像連續失敗");
    expect(text).toContain("分享給服務帳號");
    expect(text).toContain("/status");
  });

  it("只帶錯誤類別與狀態碼", () => {
    // Google 的錯誤訊息會回帶試算表 id，而這則訊息會留在 Telegram 的聊天記錄裡。
    // state.lastError 是 describeSheetFailure 的產物（"分類:狀態碼"），本來就只有
    // 這兩個資訊；原始訊息連傳進來的機會都沒有（notifier 只收 state）。
    expect(sheetsAttentionText(failedState("permanent:403"))).toContain("permanent:403");
  });

  it("沒有分類可講時不印出 null", () => {
    expect(sheetsAttentionText(failedState(null))).not.toContain("null");
  });
});

describe("createSheetsAttentionNotifier", () => {
  it("把告警送給 owner", async () => {
    const sent: { chatId: string; text: string }[] = [];
    const notify = createSheetsAttentionNotifier({
      chatId: OWNER,
      api: {
        sendMessage: (chatId, text) => {
          sent.push({ chatId, text });
          return Promise.resolve(undefined);
        },
      },
      logError: () => undefined,
    });

    await notify(failedState("transient:503"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(OWNER);
    expect(sent[0]?.text).toContain("Sheets 鏡像連續失敗");
  });

  it("送不出去時記一行並把錯誤往外拋", async () => {
    // 往外拋是刻意的：呼叫端（sheet-mirror.ts）只在 onNeedsAttention 沒拋錯時才
    // 蓋節流時間戳。自己吞掉就等於謊報成功——使用者接下來十分鐘收不到任何告警，
    // 而他其實一則都還沒收到（沿用 notify-attention.ts 裁決過的語意）。
    const logError = vi.fn();
    const notify = createSheetsAttentionNotifier({
      chatId: OWNER,
      api: { sendMessage: () => Promise.reject(new Error("Telegram unavailable")) },
      logError,
    });

    await expect(notify(failedState("permanent:403"))).rejects.toThrow("Telegram unavailable");
    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0]?.[0]).toBe("sheet mirror attention alert could not be sent");
  });
});
