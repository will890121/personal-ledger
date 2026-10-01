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

/**
 * /status 的 Sheets 區段要顯示的原始資料。時間都是 ISO 字串（或 `null` 代表
 * 「從未」），時區換算留給這個模組自己用注入的 `timeOfDay`／`dateOf` 做——
 * 呼叫端（telegram/handlers/status.ts）只負責把 repository 讀到的東西原封不動
 * 交過來，不做任何格式化。
 */
export interface SheetsStatusView {
  readonly lastSuccessAt: string | null;
  /** 分類字串（例如 "transient:503"），沒有失敗時是 null。見 sheets/sheet-failure.ts。 */
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly lastReconciledAt: string | null;
  readonly backlog: number;
  /** backlog 撞到查詢上限：畫面要印「N+」，不能讓人誤以為那就是精確數字。 */
  readonly backlogAtLimit: boolean;
}

/**
 * 鏡像關閉時只印這一行。刻意不印任何欄位或 0——空白或一排 0 會被誤讀成
 * 「鏡像開著但一直失敗」，而使用者可能只是還沒設定 Sheets 憑證
 * （config.sheets 為 null，見 src/config.ts）。
 */
const SHEETS_DISABLED_LINE = "Sheets 鏡像：未啟用";

function formatSheetsSection(
  sheets: SheetsStatusView | null,
  timeOfDay: (at: Date) => string,
  dateOf: (at: Date) => string,
): string[] {
  if (sheets === null) return ["", SHEETS_DISABLED_LINE];

  // 「從未同步過」與「從未完整校正過」都必須跟啟用中的健康畫面長得不一樣——
  // 不能印成空白或看起來像時間的東西，否則會被誤讀成「剛剛才同步過」。
  //
  // 兩個時間戳都走同一個格式化函式，而且都帶日期。曾經只有「最後完整校正」帶日期，
  // 「最後成功同步」只印時分——2026-10-01 的人工驗收踩到那個情境：14 小時前的同步
  // 顯示成「11:19」，看起來像剛剛才同步過。`lastSuccessAt` 只在真的寫入時才更新
  // （閒置的 tick 在碰任何東西之前就早退，那是配額設計的基礎），所以「沒有新帳所以
  // 沒動」與「壞掉很久了」會長得一模一樣，而分辨這兩者正是 /status 存在的理由。
  // 兩處各自格式化同一種東西，就是它們當初漂移的原因，所以收成一個函式。
  const absoluteTime = (iso: string): string => {
    const at = new Date(iso);
    return `${dateOf(at)} ${timeOfDay(at)}`;
  };
  const lastSync =
    sheets.lastSuccessAt === null ? "從未同步過" : absoluteTime(sheets.lastSuccessAt);
  const lastReconciled =
    sheets.lastReconciledAt === null ? "從未完整校正過" : absoluteTime(sheets.lastReconciledAt);
  const backlogText = `${String(sheets.backlog)}${sheets.backlogAtLimit ? "+" : ""} 筆`;

  return [
    "",
    "Sheets 鏡像",
    `最後成功同步：${lastSync}`,
    `落後：${backlogText}`,
    `連續失敗：${String(sheets.consecutiveFailures)} 次`,
    `最後錯誤：${sheets.lastError ?? "無"}`,
    `最後完整校正：${lastReconciled}`,
  ];
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
 * `dateOf` 是第五個參數，跟 `timeOfDay` 同一套時區、只是多印日期：Sheets 區段的
 * 「最後完整校正時間」可能是好幾天前，光印時分會讓「昨天校正過」跟「上星期校正過」
 * 長得一模一樣，蓋掉校正停住的唯一訊號。
 * `sheets` 是第六個參數：Sheets 鏡像狀態，`null` 代表整個鏡像關閉（見
 * SheetsStatusView 與 dependencies.ts 的說明）。
 */
export function formatStatus(
  summary: OutboxSummary,
  schemaVersion: number,
  now: Date,
  timeOfDay: (at: Date) => string,
  dateOf: (at: Date) => string,
  sheets: SheetsStatusView | null,
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
  lines.push(...formatSheetsSection(sheets, timeOfDay, dateOf));

  // `/status` 是**報表**，不是清單：沒有分頁、沒有項目、沒有逐項操作，只是一份狀態快照。
  // 因此它沒有「關閉清單」，也不套用「只保留最後一份清單」的規則——過期的報表就像對話裡
  // 任何一則舊訊息，留著無害。`/today`、`/month` 同屬報表，從一開始就是零按鈕。
  //
  // 這裡曾經有一顆「關閉清單」，理由寫的是「與其他五支清單指令一致」。那個一致性套在錯的
  // 分類上：清單的按鈕綁特定項目的 id，過期的清單按下去會動到錯的東西，所以才需要關閉鍵與
  // 單一清單規則；報表沒有這個問題。
  //
  // 唯一的例外是「重試全部」，而它是條件式的：空佇列時按下去只會是個沒有效果的按鈕，
  // 容易讓人誤以為「按了才會重試」，所以只有真的有 needs_attention 時才出現。
  // 它讀的是當下的狀態、而且重試是冪等的，所以在一份過期的報表上按它最壞只是沒有效果。
  const keyboard: InlineKeyboardButton[][] =
    summary.needsAttention > 0 ? [[{ text: "重試全部", callback_data: "outbox-retry" }]] : [];

  return {
    text: lines.join("\n"),
    // 沒有按鈕時不要附空的 inline_keyboard：Telegram 會留一塊空白的鍵盤區域。
    ...(keyboard.length > 0 ? { replyMarkup: { inline_keyboard: keyboard } } : {}),
  };
}
