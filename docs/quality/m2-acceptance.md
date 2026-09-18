# M2 驗收證據

日期：2026-09-18

## 自動驗證

- `pnpm check`：通過，22 個 test files、80 個 tests 全數通過；format、typecheck、lint 與 build 通過。
- M1 schema version 1 實體 fixture：可由 runtime 自動升級至 version 2。
- Migration：保留舊交易與配置、封存未完成草稿、foreign key 完整、重複啟動冪等。
- 固定帳務 fixture：資金流、個人財務與分類淨支出使用 Decimal 精確通過。
- Audit：create、update、delete、link、unlink 均有來源事件與 AuditEvent 測試。
- 權限：非擁有者與群組更新由 Telegram adapter 忽略。
- Docker Compose：以測試環境變數執行 `docker compose config --quiet` 通過。
- Docker image：`personal-ledger:m2` 建置通過，image ID `sha256:0bbd4236f94c6f7636e448fc0af6e1e7278c48965c82a5af7b271d6a37bf1467`。
- Container startup：使用測試 token、測試 owner ID、暫存 SQLite 路徑及 `LEDGER_STARTUP_CHECK=1` 啟動成功並正常結束。

## 人工 Telegram 驗收

下列項目必須使用私人測試資料執行；本文件只記錄結果，不記錄原始訊息、token、使用者 ID 或交易 ID。

- [ ] AC-01 至 AC-08
- [ ] AC-15、AC-16、AC-18、AC-19
- [ ] `/today` 與 `/month` 雙口徑數值正確
- [ ] 其他使用者與群組無法取得資料
- [ ] Container 重啟後 migration、交易、audit 與摘要仍正確

## 結論

自動驗證與人工驗收全部完成前，M2 維持「待驗收」狀態，不進入 M3 規劃。
