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

狀態：M3a（批次與對話狀態）已完成（2026-09-24，自動驗證於 2026-09-21 完成，人工 Telegram 驗收於 2026-09-24 結案）；M3b（代墊與回收）已完成（2026-09-25，自動驗證、程式審查與人工 Telegram 驗收全部通過）。

設計：[`docs/domain/conversation-model.md`](domain/conversation-model.md)

交付內容：

- `batch_id` 與一則訊息最多 10 筆草稿。
- 部分解析失敗、欄位追問及 reply-to 草稿路由。
- 永久待處理清單、重新預覽、封存。
- 代墊、部分回收、超額回收及放棄回收。
- `/pending` 與 `/advances`。

通過條件：AC-09 至 AC-14 全部通過，並以至少 20 條匿名化真實輸入建立解析回歸測試集。

### M3 之後的解析器改進（非里程碑）

M3b 結案後做的兩件事，都是從人工驗收與使用者提問長出來的，不屬於任何里程碑，但改動了
分類模型與 migration，所以記在這裡。設計見
[`docs/domain/category-model.md`](domain/category-model.md)。

**分類關鍵字對照表**（2026-09-26，migration 0006、測試 321 → 345）

M2 的解析器只認得「午餐」一個關鍵字，其餘句子只要帶得出帳戶就一律預設成午餐 ——
「早餐 100 現金」「電影 300 國泰卡」「國泰卡刷 1200」全都被靜靜記成午餐，而且欄位齊全、
連追問都沒有。改成關鍵字對照表（最長優先，商家與帳戶不再暗示分類），對不上就追問。
同時把「午餐」從第二層分類降為 `subcategory`，葉分類改名為「餐飲」—— 規格書 AC-01 寫的
本來就是「餐飲草稿」，M2 的命名是實作偏離規格。

驗收紀錄：[`docs/quality/category-keywords-acceptance.md`](quality/category-keywords-acceptance.md)

**使用者自訂分類關鍵字**（2026-09-29，migration 0007、測試 345 → 384）

內建關鍵字表刻意只放餐別與明確品類，所以「一蘭拉麵」「牛排」每次都得手動選分類。
補完分類後 bot 會問一次「要記住嗎」，答應了就寫進 `user_category_keywords`，下次直接命中；
`/keywords` 可列出與刪除。原本設計成「商家記憶」，因使用者提問「如果我輸入的是牛排，
這樣也會變成商家嗎」而改向 —— 殘餘文字偵測分不出店名與品項，把品項寫進 `merchants`
會污染商家概念。真正的商家登記留在
[`docs/todo/merchant-registration.md`](todo/merchant-registration.md)。

驗收紀錄：[`docs/quality/user-category-keywords-acceptance.md`](quality/user-category-keywords-acceptance.md)

### M4：可靠性、工作佇列與可觀測性

狀態：已完成（2026-09-30，schema 8，510 個測試）。

交付內容：

- SQLite 持久化 jobs/outbox（`outbox_messages`，migration `0008_outbox.sql`）。
- lease、指數退避、最大重試及 `needs_attention`。
- 啟動恢復、重複 callback、重複 update 及 crash recovery 測試。
- `/status`、異常通知及正式環境日誌遮罩。
- migration 前備份（`src/db/pre-migration-snapshot.ts`）及失敗停止啟動。
- `WAL` + `synchronous=FULL`（`src/db/database.ts`），`/help` 依規格補齊語法範例。

通過條件：AC-20、AC-23、AC-24、AC-28 通過；在確認後強制終止程序也不遺失或重複交易。

驗收紀錄：[`docs/quality/m4-acceptance.md`](quality/m4-acceptance.md)

### M5：Google Sheets、備份與維護 CLI

M5 拆成三塊，順序 a → b → c。M5a 先做，因為使用者要把 Sheet 當成主要的查看介面。
設計見 [`docs/superpowers/specs/2026-09-30-m5a-sheets-mirror-design.md`](superpowers/specs/2026-09-30-m5a-sheets-mirror-design.md)。

#### M5a：Google Sheets 單向鏡像

狀態：**實作完成、驗收未完成**（2026-10-01，schema 9，90 檔 / **667 個測試**，
M4 結案時的起點是 510）。三道關卡只過了第一道，**尚未結案**（與
[`docs/quality/m5a-acceptance.md`](quality/m5a-acceptance.md) 同一種切法：
`pnpm test:sheets` 併在關卡一，不算獨立的第四道）：

| 關卡 | 狀態 |
|---|---|
| 自動驗證（`pnpm check` exit 0，另加 `pnpm test:sheets` 對真實試算表跑綠） | 🟡 部分完成——`pnpm check` 已綠，`pnpm test:sheets` 未執行（實作環境沒有 GCP 憑證，從未對真實 Google 跑過） |
| 整個分支的程式審查 | ⬜ 未完成 |
| 人工驗收清單 | ⬜ 未執行 |

交付內容：

- `Transactions`、`Allocations`、`MonthlySummary` 三張分頁的鏡像
  （Accounts／Categories／AuditLog 的鏡像不在 M5a 範圍內）。
- 收斂式同步：以 `transactions.updated_at` 為游標、以 id 為鍵 upsert，
  20 秒增量同步（1 分鐘新鮮度目標）、每日凌晨 4 點全表校正、殭屍列清理。
- 失敗分類（暫時／永久）、連續五次失敗升級成 Telegram 告警並節流十分鐘、
  `/status` 的鏡像區段、正式日誌遮罩金鑰與試算表 id。
- migration `0009_sheet_sync_state.sql`（游標與同步狀態）。
- 明確型別的儲存格寫入：金額是數字（可 SUM）、日期是序列值加日期格式（可排序、
  可算月份）、以 `=` 開頭的備註留在字面上而不變成公式。
- 對真實 Sheets 的整合測試與替身差分測試（`pnpm test:sheets`，不在 `pnpm check` 內）。

通過條件：AC-21、AC-22 通過；在 Sheet API 故障期間仍可正常入帳。

驗收紀錄：[`docs/quality/m5a-acceptance.md`](quality/m5a-acceptance.md)

#### M5b：備份排程、異地副本、還原 CLI

狀態：尚未開始。

交付內容：SQLite 本機與 Google Drive 每日快照、備份排程、還原 CLI。

通過條件：AC-25 通過。

#### M5c：匯出與永久刪除 CLI

狀態：尚未開始。

交付內容：CSV、JSON、SQLite 匯出；Sheet 校正 CLI；永久刪除敏感原文。

通過條件：AC-29 通過。

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
| M3 後 | `docs/domain/category-model.md`、`docs/todo/merchant-registration.md` |
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

M0 至 M4 全部完成並上線（2026-09-30，schema 8，510 個測試）。

**M5a（Google Sheets 單向鏡像）的實作與自動驗證已完成，但還沒有結案**
（2026-10-01，schema 9，667 個測試）。三件未完成的事：`pnpm test:sheets` 對一張
拋棄式試算表跑綠、整個分支的程式審查、以及
[`docs/quality/m5a-acceptance.md`](quality/m5a-acceptance.md) 的人工驗收清單。
在這三件完成之前，M5a 不算通過，也不該開始 M5b ——
下一個里程碑是 **M5b：備份排程、異地副本、還原 CLI**，尚未開始。

在那之前值得注意的幾件事：

1. 備份已經有可用、已實測的腳本（`scripts/backup.sh`，`VACUUM INTO` + `integrity_check` +
   保留政策），migration 前也已經自動快照（`src/db/pre-migration-snapshot.ts`）。還缺的是
   排程（目前仍要人工執行 `scripts/backup.sh`）與異地副本；還原 CLI 排在 M5，見
   [`docs/operations/backup-and-restore.md`](operations/backup-and-restore.md)。上面第 5
   節的「每週至少執行一次手動 Docker 啟動與資料還原演練」現在就該開始，不用等 M5。
2. `docs/todo/merchant-registration.md` 掛在 M6 dogfood 決定：兩週真實記帳若出現
   「想按商家看支出」或「一直為店名教關鍵字」其中之一就成立，屆時進 M8；都沒出現就
   關掉。延後是安全的，因為 `rawInputSnapshot` 保留了原句，之後可以回填。
