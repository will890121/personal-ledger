# 待辦：遞送失敗要留下日誌痕跡

提出時間：2026-09-30，M4 關卡三人工驗收期間發現。

## 問題

驗收第 3–6 項刻意製造了一場完整的遞送事故：斷網、反覆重試（指數退避）、用盡
`MAX_ATTEMPTS`、升級成 `needs_attention`、發出告警、最後手動「重試全部」補送成功。

**整場事故在 `docker logs` 裡沒有留下任何一行。** 驗收後的日誌只有兩次
「Ledger Bot runtime ready」，共 246 位元組。

全專案九個 logger 呼叫點，沒有一個在正常的遞送失敗路徑上：

| 事件 | 目前有記錄嗎 |
|---|---|
| 送出失敗、排定退避重試 | ❌ 只寫進 `outbox_messages.last_error` |
| 用盡重試上限、轉 `needs_attention` | ❌ |
| 告警送出（或告警本身送不出去） | ❌（`notify-attention.ts` 刻意吞掉自己的失敗） |
| 使用者按「重試全部」 | ❌ |
| drain 迴圈整個拒絕 | ✅ `outbox drain failed`（C1 修正加的） |
| 陳舊 worker 的寫入被 CAS 擋下 | ✅ `outbox row already had a newer result`（N1 修正加的） |

## 為什麼這是缺口

`/status` 是 M4 設計的可觀測性介面，它運作正常 —— 但它顯示的是**當下狀態**。
事故結束後狀態就乾淨了，沒有任何痕跡。因此答不出這幾個問題：

- 這種情況以前發生過嗎？多久一次？
- 那次遞送總共失敗幾次、隔多久、錯誤是什麼？
- 告警到底有沒有送出去？（`notify-attention.ts` 會吞掉自己的失敗，靜默程度最高的一條路徑）

對一個 `restart: unless-stopped` 的長跑服務來說，事後重建時間線的唯一材料就是日誌。

## 修法（估計三到五行加對應測試）

在 `src/telegram/outbox-runner.ts` 的 `handleDeliveryFailure` 補：

1. 重試分支：`logger.info`，帶 `messageId`、`attempts`、`delayMs`、錯誤描述。
2. 放棄分支（兩處，`give-up` 與用盡上限）：`logger.warn`，帶 `messageId`、`attempts`、錯誤描述。
3. `notify-attention.ts` 吞掉自己的失敗時記一行 —— 現在是全專案最安靜的失敗路徑。

**不得記入的內容**：訊息本文（那是財務原文）、`chatId` 原始值、`targetMessageId` 以外的
Telegram 內容。`messageId` 是 outbox 的內部識別碼，可以記。遮罩由 `src/logger.ts` 負責，
但別依賴它擋下你本來就不該傳進去的東西。

## 完成標準

拔掉任何一行新增的日誌，都要有測試變紅 —— 本分支 13 個任務栽在「程式對、守衛空轉」上，
日誌也一樣，沒有測試釘住的日誌下次重構就會消失。

## 為什麼不在 M4 做

M4 的通過條件是 AC-20／23／24／28，四項都過了，這不在其中。分支當時已經跑完兩輪完整
審查（整分支審查 35 個變異、修正後複審重現全部原始失敗情境），為一個非 AC 的改善重開
並不划算。排在 M5 前段，讓它有自己的任務、測試與審查。
