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

// 所有時間都以 toISOString() 存成 UTC；telegram 層目前沒有時區可用
// （config.timezone 只在 main.ts 算「今天日期」時用過，沒有一路傳進來），
// 與其假裝有時區而弄錯，不如老實顯示 UTC 的時分。
function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

function minutesAgo(iso: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
}

function stuckLines(stuck: readonly OutboxMessage[]): string[] {
  return stuck.flatMap((message) => {
    const header = `⚠️ ${causeLabels[message.cause]} · ${hhmm(message.nextAttemptAt)} · 已重試 ${String(message.attempts)} 次`;
    // 只印 Telegram 自己回的 description，絕不印訊息內文、金額或分類名稱——
    // 那些是財務資料，不該出現在告警或狀態畫面裡。
    return message.lastError ? [header, `   ${message.lastError}`] : [header];
  });
}

/**
 * 純函式：不碰 repository、不碰時鐘（除了呼叫端傳進來的 now）。
 * `now` 是額外加的第三個參數——summary 裡的時間都是絕對值（ISO 字串），
 * 「幾分鐘前」這種相對敘述離不開「現在是幾點」，沒有它就只能印絕對時間，
 * 資訊量會變少，因此在原訂介面之外加了這個參數。
 */
export function formatStatus(
  summary: OutboxSummary,
  schemaVersion: number,
  now: Date,
): DraftPrompt {
  const oldestSuffix =
    summary.pending > 0 && summary.oldestPendingAt
      ? `（最舊 ${String(minutesAgo(summary.oldestPendingAt, now))} 分鐘前）`
      : "";
  const attentionSuffix = summary.needsAttention > 0 ? " ⚠️" : "";
  const lastDelivered = summary.lastDeliveredAt ? hhmm(summary.lastDeliveredAt) : "從未";

  const lines = [
    `待送 ${String(summary.pending)} 筆${oldestSuffix}`,
    `待處理 ${String(summary.needsAttention)} 筆${attentionSuffix}`,
    `最後成功遞送：${lastDelivered}`,
    `schema 版本：${String(schemaVersion)}`,
  ];
  if (summary.stuck.length > 0) {
    lines.push("", ...stuckLines(summary.stuck));
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
