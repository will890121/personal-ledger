import type { InlineKeyboardButton } from "grammy/types";

import type { OutboxCause, OutboxMessage } from "../domain/outbox.js";
import type { OutboxSummary } from "../ports/ledger-repository.js";
import type { DraftPrompt } from "./format-prompt.js";

// cause 是給程式看的英文列舉，/status 是給人看的畫面，因此轉成中文；
// 這幾個詞只在這裡使用，不影響其他地方對 cause 的判斷。
const causeLabels: Record<OutboxCause, string> = {
  transaction_confirmed: "確認交易",
  recovery_recorded: "記錄回收",
  advance_abandoned: "放棄代墊",
  transaction_updated: "更新交易",
  transaction_deleted: "刪除交易",
};

function minutesAgo(iso: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
}

function stuckLines(stuck: readonly OutboxMessage[], timeOfDay: (at: Date) => string): string[] {
  return stuck.flatMap((message) => {
    // nextAttemptAt 不是「放棄的那一刻」的精確時間戳：markOutboxNeedsAttention 不會
    // 更新它，這裡讀到的是放棄之前最後一次被排定重試的時間。OutboxMessage 上沒有
    // createdAt 可用（見 domain/outbox.ts 與 ports/ledger-repository.ts 的說明），
    // 這是目前拿得到、最接近「放棄時刻」的替代值，讀者不該把它當成精確時間戳。
    const header = `⚠️ ${causeLabels[message.cause]} · ${timeOfDay(new Date(message.nextAttemptAt))} · 已重試 ${String(message.attempts)} 次`;
    // 只印 Telegram 自己回的 description，絕不印訊息內文、金額或分類名稱——
    // 那些是財務資料，不該出現在告警或狀態畫面裡。
    return message.lastError ? [header, `   ${message.lastError}`] : [header];
  });
}

/**
 * 純函式：不碰 repository、不碰時鐘、不碰時區——`now` 與 `timeOfDay` 都由呼叫端
 * （telegram/handlers/status.ts）從 dependencies 帶進來。
 * `now` 是額外加的第三個參數：summary 裡的時間都是絕對值（ISO 字串），
 * 「幾分鐘前」這種相對敘述離不開「現在是幾點」，原訂介面沒有這個參數就只能印絕對
 * 時間，資訊量會變少。
 * `timeOfDay` 同理是第四個參數：把 ISO 時刻換算成「幾點幾分」需要知道使用者設定的
 * 時區，而這個模組不該自己認得時區是什麼——認錯或漏接時區的後果，是一則八小時前
 * 就送達的訊息被讀成「還在等」，這正是 /status 要防止的誤判。
 */
export function formatStatus(
  summary: OutboxSummary,
  schemaVersion: number,
  now: Date,
  timeOfDay: (at: Date) => string,
): DraftPrompt {
  const oldestSuffix =
    summary.pending > 0 && summary.oldestPendingAt
      ? `（最舊 ${String(minutesAgo(summary.oldestPendingAt, now))} 分鐘前）`
      : "";
  const attentionSuffix = summary.needsAttention > 0 ? " ⚠️" : "";
  const lastDelivered = summary.lastDeliveredAt
    ? timeOfDay(new Date(summary.lastDeliveredAt))
    : "從未";

  const lines = [
    `待送 ${String(summary.pending)} 筆${oldestSuffix}`,
    `待處理 ${String(summary.needsAttention)} 筆${attentionSuffix}`,
    `最後成功遞送：${lastDelivered}`,
    `schema 版本：${String(schemaVersion)}`,
  ];
  if (summary.stuck.length > 0) {
    lines.push("", ...stuckLines(summary.stuck, timeOfDay));
  }

  const keyboard: InlineKeyboardButton[][] = [
    // 空佇列時按下去只會是個沒有效果的按鈕，容易讓人誤以為「按了才會重試」；
    // 只有真的有 needs_attention 時才出現。
    ...(summary.needsAttention > 0 ? [[{ text: "重試全部", callback_data: "outbox-retry" }]] : []),
    // 與其他五支清單指令一致，最後一列固定是關閉清單。
    [{ text: "關閉清單", callback_data: "dismiss-status" }],
  ];

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: keyboard },
  };
}
