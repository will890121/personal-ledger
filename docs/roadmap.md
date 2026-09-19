# Personal Ledger 交付路線圖

日期：2026-09-17  
產品：Ledger Bot  
程式庫名稱：`personal-ledger`  
主要規格：[`docs/spec/personal-ledger-spec.md`](spec/personal-ledger-spec.md)

## 1. 現在所處階段

需求探索已完成，v0.2 規格可以作為實作基準。現在不應繼續擴張功能，也不需要先拆出所有技術文件；下一步是建立可執行的專案骨架，完成第一條端到端交易路徑，讓架構接受真實程式與測試驗證。

第一個成功畫面必須是：

```text
午餐 120
→ Ledger Bot 顯示交易預覽
→ 使用者按下確認
→ SQLite 產生正式交易與 allocation
→ /recent 可以查到該筆交易
```

## 2. 執行原則

- 每個里程碑都必須產生可運行、可測試的軟體。
- 先完成垂直切片，再擴充橫向基礎設施。
- 帳務領域模組不依賴 Telegram、Google Sheets 或 AI。
- 外部服務一律透過轉接器接入。
- 每個功能先寫失敗測試，再寫最小實作。
- 每個里程碑結束都執行完整 test、typecheck 及 lint。
- 未通過里程碑條件，不進入下一階段。
- AI、雲端部署及 Sheet 設定同步依規格延後，不提前綁定供應商。

## 3. 里程碑

### M0：程式庫與工程基線

交付內容：

- 初始化 Git、Node.js 24 LTS、pnpm、TypeScript 6。
- 建立 Vitest、ESLint flat config、格式化及 typecheck。
- 建立 Docker 開發／正式執行方式。
- 建立設定驗證，以及不洩漏敏感資料的啟動錯誤處理。
- 建立 `README.md` 與 `.env.example`。

通過條件：全新檢出的程式庫可用一組命令完成安裝、測試、型別檢查及 Docker 建置。

### M1：第一條端到端垂直切片

交付內容：

- TWD 金額值物件。
- 第一版 SQLite migration。
- InputEvent、Draft、Transaction、Allocation 儲存庫介面。
- 規則解析 `午餐 120`。
- Telegram 白名單、預覽、確認、取消及 `/recent`。
- `request_id` 與 Telegram update 冪等保護。

通過條件：規格 AC-01、AC-05、AC-06、AC-26 的縮小版通過，程式重啟後資料仍存在。

詳細計畫：[`docs/superpowers/plans/2026-09-17-foundation-first-slice.md`](superpowers/plans/2026-09-17-foundation-first-slice.md)

### M2：帳務核心完整化

狀態：已完成（2026-09-19）

交付內容：

- 完整 `funds_effect`、`purpose` 及 allocation 驗證。
- 收入、支出、內部轉帳、退款及手續費。
- 帳戶、分類、商家、counterparty 及標籤。
- 修改、軟刪除、AuditLog 及來源事件鏈。
- 今日、本月及分類統計。

通過條件：AC-01 至 AC-08、AC-15、AC-16、AC-18、AC-19 通過；固定帳務資料的統計結果 100% 正確。

### M3：對話狀態、多筆輸入與代墊

交付內容：

- `batch_id` 與一則訊息最多 10 筆草稿。
- 部分解析失敗、欄位追問及 reply-to 草稿路由。
- 永久待處理清單、重新預覽、封存。
- 代墊、部分回收、超額回收及放棄回收。
- `/pending` 與 `/advances`。

通過條件：AC-09 至 AC-14 全部通過，並以 20 至 30 條匿名化真實輸入建立解析回歸測試集。

### M4：可靠性、工作佇列與可觀測性

交付內容：

- SQLite 持久化 jobs/outbox。
- lease、指數退避、最大重試及 `needs_attention`。
- 啟動恢復、重複 callback、重複 update 及 crash recovery 測試。
- `/status`、異常通知及正式環境日誌遮罩。
- migration 前備份及失敗停止啟動。

通過條件：AC-20、AC-23、AC-24、AC-28 通過；在確認後強制終止程序也不遺失或重複交易。

### M5：Google Sheets、備份與維護 CLI

交付內容：

- Transactions、Allocations、Accounts、Categories、AuditLog、MonthlySummary 鏡像。
- 非同步 upsert、1 分鐘新鮮度目標及每日完整校正。
- SQLite 本機與 Google Drive 每日快照。
- CSV、JSON、SQLite 匯出。
- 備份還原、Sheet 校正及永久刪除 CLI。

通過條件：AC-21、AC-22、AC-25、AC-29 通過；在 Sheet API 故障期間仍可正常入帳。

### M6：Dogfood Release

交付內容：

- 以真實帳務連續使用至少兩週。
- 每日檢查待處理、錯誤、重複與統計差異。
- 修正所有阻斷性及資料正確性問題。
- 完成部署、還原及操作文件。
- 將穩定版本標記為 `v0.1.0`。

通過條件：連續七天沒有資料遺失、重複入帳或未解釋的統計差異，且可從備份完整還原。

### M7：AI 解析與自然語言查詢

交付內容：

- 供應商中立的 AI 轉接器。
- 評測集、影子模式及解析差異報告。
- AI 結構輸出驗證及 prompt version。
- AI 草稿填入；正式入帳仍必須確認。
- 受限 QuerySpec，自然語言不得直接產生 SQL。

通過條件：人工確認評測結果、資料政策、成本與延遲後才正式啟用；沒有 AI API Key 時核心功能仍全部可用。

### M8：第二階段財務能力

依 dogfood 使用頻率排序實作：

1. 借出、借入及還款餘額。
2. 外幣與海外手續費。
3. 信用卡分期付款預估。
4. 每月摘要與通知偏好。
5. Sheet 分類／規則設定同步。
6. 歷史資料匯入。

每項能力獨立建立實作計畫，不合併為一次大型發布。

通過條件：每項能力具備獨立驗收案例，且不得破壞既有帳務統計、來源追蹤與備份還原能力。

## 4. 文件策略

目前保留 `personal-ledger-spec.md` 作為需求基準，不立即拆散。文件在相應里程碑開始時再產生，確保內容來自真實設計：

| 時機 | 文件 |
|---|---|
| M1 | `README.md`、第一版資料模型及 migration 說明 |
| M2 | `docs/domain/accounting-model.md` |
| M4 | `docs/architecture/system-overview.md`、必要 ADR |
| M5 | `docs/operations/backup-and-restore.md`、`runbook.md` |
| M6 | `docs/quality/acceptance-report.md` |
| M7 | AI 評測報告及 provider ADR |

只有遇到難以逆轉、存在多個合理方案的決策才建立 ADR。一般實作細節留在程式、測試與模組 README。

## 5. 建議工作節奏

- 一次只推進一個里程碑。
- 每個工作單位控制在半天至兩天內可審查。
- 每完成一個 transaction flow 就加入端到端測試。
- 每週至少執行一次手動 Docker 啟動與資料還原演練。
- M1 完成後立刻開始少量真實資料試用，不等 M5 才第一次操作 Bot。

## 6. 現在要做的事

1. 執行 M0 與 M1 詳細計畫。
2. 用第一條垂直切片驗證 Telegram、SQLite、領域邊界及冪等策略。
3. 根據實作結果回看 v0.2，只有發現矛盾時才更新規格。
4. M1 通過條件達成後，再為 M2 建立下一份詳細實作計畫。
