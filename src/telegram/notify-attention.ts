import type { OutboxMessage } from "../domain/outbox.js";
import { logger } from "../logger.js";
import type { LedgerRepository } from "../ports/ledger-repository.js";

/**
 * 一列訊息放棄遞送時要不要告訴使用者，以及告訴幾次。
 *
 * 壞掉的正是 Telegram 這條管道——runner 之所以放棄，就是因為送不出去。用同一條
 * 管道發告警，很可能一樣送不出去。所以這裡刻意選最誠實的做法：
 *   - 告警是「盡力而為」的直接發送，不是另一筆 outbox 列。排進 outbox 只會在管道
 *     持續故障時，不斷生出一批永遠送不出去的告警列。
 *   - 告警本身失敗就吞掉。丟例外會讓 drainOnce 整批中斷，這一列後面排隊的列
 *     連試都不會被試到。
 *   - 真正的後備管道是 /status：連線恢復後使用者自己會看到卡住的列。
 *
 * 節流用 settings 裡的 outbox_last_alert_at（ISO 字串）記錄「上一次成功送出告警」
 * 的時間，而不是「上一次嘗試」的時間：告警沒送到就等於沒發生過，不該因為一次
 * 失敗就讓使用者接下來十分鐘完全收不到任何告警。
 */

const THROTTLE_MS = 10 * 60_000;
const ALERT_SETTING_KEY = "outbox_last_alert_at";

// 不放金額、分類、原文——這則訊息可能在管道半通不通時送出，用途只是「去看
// /status」，不是重述交易內容。
const ALERT_TEXT =
  "⚠️ 有訊息送不出去\n帳已經記好了，只是通知沒送到。連線恢復後用 /status 查看並重試。";

/**
 * 刻意收窄的介面：告警一律送新訊息，用不到 editMessageText，測試也不需要整個
 * grammY Bot。
 */
export interface AttentionNotifierApi {
  sendMessage(chatId: string, text: string): Promise<unknown>;
}

export interface AttentionNotifierDependencies {
  readonly repository: LedgerRepository;
  readonly ownerId: string;
  readonly api: AttentionNotifierApi;
  readonly now: () => Date;
}

export function createAttentionNotifier(
  deps: AttentionNotifierDependencies,
): (message: OutboxMessage) => Promise<void> {
  return async (message: OutboxMessage): Promise<void> => {
    const lastAlertAt = await deps.repository.getSetting(deps.ownerId, ALERT_SETTING_KEY);
    const now = deps.now();
    if (lastAlertAt !== null && now.getTime() - Date.parse(lastAlertAt) < THROTTLE_MS) {
      return;
    }

    try {
      await deps.api.sendMessage(message.chatId, ALERT_TEXT);
    } catch (error) {
      // 吞掉：見檔頭說明。這一列已經被標成 needs_attention，/status 會顯示。
      // 但吞掉不等於沒發生過——這是全專案最安靜的失敗路徑，記一行讓事後能
      // 從 docker logs 看出告警確實沒送到，而不是誤以為使用者當時有收到通知。
      logger.warn("notify-attention failed to send its own alert", {
        messageId: message.messageId,
        chatId: message.chatId,
        error,
      });
      return;
    }
    await deps.repository.setSetting(deps.ownerId, ALERT_SETTING_KEY, now.toISOString());
  };
}
