/**
 * 指令清單的唯一定義。`/help` 的文字、setMyCommands 的參數、handler 註冊三者都讀這一份，
 * 新增指令時忘記更新 help 這件事因此不可能發生。
 *
 * 本專案已經因為「同一件事兩份定義」出過三次問題（分類名稱、allocation 的顯示邏輯、
 * 四支清單指令裡漏掉一個「關閉清單」按鈕），指令清單不該是第四次。
 */
export const LEDGER_COMMANDS = [
  { command: "pending", description: "待處理草稿" },
  { command: "advances", description: "未回收代墊" },
  { command: "recent", description: "最近交易" },
  { command: "today", description: "今日統計" },
  { command: "month", description: "本月統計" },
  { command: "keywords", description: "教過的分類關鍵字" },
  { command: "status", description: "服務狀態與待送訊息" },
  { command: "help", description: "怎麼記帳與指令一覽" },
] as const;
