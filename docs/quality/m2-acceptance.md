# M2 驗收證據

日期：2026-09-19

## 自動驗證

- `pnpm check`：通過，22 個測試檔、84 個測試全數通過；format、typecheck、lint 與 build 通過。
- M1 schema version 1 實體 fixture：可由 runtime 自動升級至 version 2。
- Migration：保留舊交易與配置、封存未完成草稿、foreign key 完整、重複啟動冪等。
- 固定帳務 fixture：資金流、個人財務與分類淨支出使用 Decimal 精確通過。
- Audit：create、update、delete、link、unlink 均有來源事件與 AuditEvent 測試。
- 權限：非擁有者與群組更新由 Telegram adapter 忽略。
- Docker Compose：以測試環境變數執行 `docker compose config --quiet` 通過。
- Docker image：`personal-ledger:m2` 建置通過，image ID `sha256:16842e700e1396d3e468ea1ad722dc8de0914b8455840c5a6ef66a6b88aec8bf`。
- Container startup：使用測試 token、測試 owner ID、暫存 SQLite 路徑及 `LEDGER_STARTUP_CHECK=1` 啟動成功並正常結束。

## 人工 Telegram 驗收

下列項目必須使用私人測試資料執行；本文件只記錄結果，不記錄原始訊息、token、使用者 ID 或交易 ID。

- [x] AC-01 至 AC-08
- [x] AC-15、AC-16、AC-18、AC-19
- [x] `/today` 與 `/month` 雙口徑數值正確
- [x] 其他使用者與群組無法取得資料
- [x] Container 重啟後 migration、交易、audit 與摘要仍正確

人工驗收涵蓋收入、現金支出、信用卡支出、內部轉帳、卡費、轉帳手續費、退款、軟刪除及分頁交易清單。退款建立後具有 `refund_of` 關聯；刪除後交易自 `/recent` 清單移除。容器重啟前後均維持 6 筆已確認交易、1 筆已刪除交易、1 個退款關聯及對應稽核事件，foreign key 檢查無錯誤。

`/today` 與 `/month` 的資金流、個人財務及分類淨支出均與相同資料範圍的 repository 計算結果逐項一致。非白名單使用者傳送指令時，Bot 未回覆且未洩漏帳務資料。

## 結論

自動驗證與人工 Telegram 驗收全部通過，M2 完成，可進入 M3 規劃。
