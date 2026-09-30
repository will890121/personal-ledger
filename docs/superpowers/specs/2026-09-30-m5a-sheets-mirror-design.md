# M5a：Google Sheets 鏡像 設計

狀態：設計完成，待實作計畫。2026-09-30。

## 0. M5 的拆分

roadmap 的 M5 寫了三件彼此獨立的事，每一件都能自己交付可運作的軟體，塞進一份 spec 會
讓任何一份實作計畫都失焦。拆成：

| 子專案 | 內容 | AC |
|---|---|---|
| **M5a（本文）** | Google Sheets 單向鏡像 | AC-21、AC-22 |
| M5b | 備份排程、異地副本、還原 CLI | AC-25 |
| M5c | CSV／JSON／SQLite 匯出、永久刪除敏感原文 | AC-29 |

順序 a → b → c。M5a 先做，因為使用者要把 Sheet 當成主要的查看介面。

## 1. 目標

**把帳本鏡像到一張 Google Sheet，讓使用者用試算表看自己的錢。** Telegram Bot 是輸入端，
Sheet 是查看端。

使用者在設計期間確認的意圖：

- Sheet 是**主要的查看介面**，要隨時是最新的（不是偶爾匯出看一下）。
- **目前唯讀**：改帳一律回 Bot。「新增編輯留著後續擴充」—— 因此設計不得堵死日後寫回的路，
  但現在不做雙向同步。
- 先做 **Transactions、Allocations、MonthlySummary 三張分頁**。Accounts 與 Categories 是
  少量參照資料，AuditLog 是機器看的，都先不做。

## 2. 核心決定：收斂式鏡像，不是工作佇列

M4 為 Telegram 建了 outbox，因為**一則訊息是一次性副作用** —— 送兩次使用者看到兩則，
弄丟就沒了，所以需要「恰好送達一次」。

**試算表的一列是收斂狀態** —— 寫兩次無害，最後一次獲勝。鏡像需要的保證不是「每個事件恰好
處理一次」，而是「最終每一列都是對的」。用為前者設計的機制去解後者，會付出不必要的複雜度，
而且拿不到自我修復。

因此**不擴充 M4 的 outbox，也不建第二個工作佇列**，改用游標驅動的收斂同步。

被否決的兩個方案與理由：

- **擴充 `outbox_messages`**：該表深度 Telegram 化（`chat_id`、`target_message_id`、
  reply markup、`cause`），要塞進 Sheets 工作就得讓這些欄位全部可空或改成多型 payload。
  而且它給的是錯的保證。
- **獨立的 `sheet_sync_jobs` 佇列**：佇列記事件，Sheet 要狀態。同一列改三次會寫三次；
  job 掉了那列就一直錯到下次校正，而收斂式設計本來就會自己修好。

## 3. 資料流與游標

```
每 20 秒：
  1. 查 SQLite：transactions WHERE updated_at >= cursor
     ORDER BY updated_at, transaction_id LIMIT 200
  2. 沒有結果 → 結束，不打任何 API
  3. 載入這些交易的配置
  4. 讀 Sheet 各分頁的鍵欄，建 id → 列號
  5. 批次寫入三張分頁
  6. 受影響的月份用 summarizeAllocations 重算，覆寫 MonthlySummary 那幾列
  7. cursor = 這批最後一列的 (updated_at, transaction_id)
```

**「受影響的月份」的定義要精確，否則會有一類靜默的過時。** 一筆交易的 `occurred_date`
若被改到別的月份，新舊兩個月的摘要都變了，但只看目前這列只知道新的那個月，舊的那個月會
悄悄停在錯的數字。

解法不需要額外的 API 呼叫：步驟 4 本來就要讀 Transactions 分頁的鍵欄，**同時把日期欄一起
讀回來**即可。於是

> 受影響的月份 = ∪（Sheet 上這些 `transaction_id` 的現有日期所屬月份，本次資料的
> `occurred_date` 所屬月份）

新交易在 Sheet 上沒有舊值，只有後者。這樣跨月搬移的兩個月都會被重算。

### 游標為什麼建在 `transactions.updated_at`

`allocations` 沒有 `updated_at`，但**所有配置變更都會推進父交易的 `updated_at`**。
已查證：`replaceAllocations` 只有兩個呼叫點 —— `confirmDraft`（INSERT 交易時寫
`updated_at`）與 `updateTransaction`（UPDATE 時寫），兩者都在同一個 SQLite 交易內。
因此交易層級的游標涵蓋配置。

**不用 `audit_events` 當變更流**：它有歷史缺口。實測線上資料有 9 筆交易、只有 8 筆有稽核
事件，缺的那筆建立於 2026-09-18T02:12，而最早的稽核事件是同日 10:42 —— 它是
`audit_events` 存在之前的 M1 資料。缺口是歷史性的不是持續的，但既然 `updated_at` 直接
表達「這列變了」且沒有缺口，就用它。

### 游標用 `>=` 不用 `>`

兩列可能共用同一個 `updated_at` 毫秒值，用 `>` 會在批次邊界漏掉一列。因為 upsert 是冪等的，
重寫幾列的代價是零。**這是收斂式設計的核心好處：用「寧可重做」換掉一整類邊界錯誤。**

實作上游標是 `(updated_at, transaction_id)` 兩欄，比較採字典序；`updated_at` 一律是
應用程式產生的 ISO8601（含毫秒），與專案其他時間欄位一致，因此字典序等於時間序。

### 刪除

軟刪除（`status = 'deleted'`）會推進 `updated_at`，走同一條路徑。鏡像**保留該列**並把
狀態欄寫成已刪除，不移除列 —— SQLite 保留它，鏡像就保留它，這樣「Sheet 是 SQLite 的投影」
這個不變量才成立。使用者要隱藏就在 Sheet 裡篩選。

### 每日校正

每日 04:00（`TZ`，即 Asia/Taipei）跑一次全表校正：把 `WHERE updated_at >= cursor` 換成
全表掃描，其餘**完全同一段程式**。不是第二條程式路徑，因此不會有「校正邏輯自己有 bug
卻沒人發現」的問題。

初次同步、以及那筆 M1 沒有稽核事件的交易，都由第一次全表校正涵蓋。

### 游標的儲存

新增 migration `0009_sheet_sync_state.sql`：

```sql
CREATE TABLE sheet_sync_state (
  owner_id              TEXT PRIMARY KEY,
  cursor_updated_at     TEXT,
  cursor_transaction_id TEXT,
  last_success_at       TEXT,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at    TEXT
);
```

**一個 owner 一列游標，三張分頁共用，不是一頁一個。** 三張分頁在同一輪裡一起寫，任何一張
失敗就整輪不推進游標，下一輪三張全部重做 —— 因為 upsert 冪等，重做的代價是零。
一頁一個游標會讓三頁的進度各自漂移，換來的只是省下幾次冪等的重寫，不划算。

游標存在 SQLite，跟著既有備份一起被保護，還原之後同步狀態也一致。

## 4. 分頁與欄位

第 1 列是標題，資料從第 2 列開始。A 欄一律是鍵。

### Transactions

| 欄 | 內容 | 型別 |
|---|---|---|
| A | `transaction_id` | 文字（鍵） |
| B | 日期 `occurred_date` | 日期 |
| C | 時間 `occurred_time` | 文字 |
| D | 金額 `amount` | 數字 |
| E | 轉出帳戶（名稱） | 文字 |
| F | 轉入帳戶（名稱） | 文字 |
| G | 商家（名稱） | 文字 |
| H | 對象（名稱） | 文字 |
| I | 備註 `note` | 文字 |
| J | 原始輸入 `raw_input_snapshot` | 文字 |
| K | 狀態 `status` | 文字 |
| L | 確認時間 `confirmed_at` | 文字 |
| M | 更新時間 `updated_at` | 文字 |

帳戶／商家／對象一律寫**名稱**不寫 id。沒有鏡像 Accounts 與 Categories 分頁，寫 id 會讓
使用者看到一排 UUID，等於沒做這個功能。

### Allocations

| 欄 | 內容 | 型別 |
|---|---|---|
| A | `allocation_id` | 文字（鍵） |
| B | `transaction_id` | 文字 |
| C | 日期（自交易反正規化） | 日期 |
| D | 資金流向 `funds_effect` | 文字 |
| E | 用途 `purpose` | 文字 |
| F | 金額 `amount` | 數字 |
| G | 分類 `category_snapshot` | 文字 |
| H | 子分類 `subcategory_snapshot` | 文字 |
| I | 對象（名稱） | 文字 |
| J | 備註 `note` | 文字 |
| K | 交易狀態（自交易反正規化） | 文字 |

**日期與交易狀態的反正規化是這張表能不能用的關鍵。** 有了它，Allocations 就是自給自足的
樞紐分析來源：可以直接做「每月每分類多少錢」、可以篩掉已刪除的，都不必 VLOOKUP 回
Transactions。少了它，這張表在試算表裡幾乎不能用。

### MonthlySummary

一列一個月份，鍵是 `YYYY-MM`。欄位是 `summarizeAllocations` 產出的八個數字：

| 欄 | 內容 |
|---|---|
| A | 月份（鍵，`YYYY-MM`） |
| B | 實際流入 `actualInflow` |
| C | 實際流出 `actualOutflow` |
| D | 淨現金流 `netCashFlow` |
| E | 個人收入 `personalIncome` |
| F | 個人支出毛額 `grossPersonalExpense` |
| G | 退款 `refunds` |
| H | 個人支出淨額 `netPersonalExpense` |
| I | 個人結餘 `personalBalance` |
| J | 更新時間 |

B–I 全部是數字。

**不做分類細項分頁。** `LedgerSummary` 有 `categories` 陣列，但 Allocations 已經帶了日期
與分類，分類統計用試算表原生樞紐分析即可。多同步一張只會多一條要維護與校正的管線。

月度摘要的計算：取該月所有配置（含已刪除交易的配置嗎？**不含** —— 已刪除的交易不應計入
統計），餵給 `summarizeAllocations`。

### 金額為什麼寫成數字

專案規則是「金錢一律 `Decimal`，絕不用 IEEE 浮點」。那條規則管的是**我們的計算**。
Sheet 是給人分析用的唯讀視圖，寫成文字就不能 SUM，功能等於白做。

界線：SQLite 仍是唯一真相，`Decimal` 仍管所有運算；Sheet 是投影。TWD 金額在 2^53 以內的
整數範圍精確，遠超過個人帳本的量級。

### 寫入的型別與公式注入

一律用 `spreadsheets.batchUpdate` 的 `UpdateCellsRequest`，每個儲存格明確指定型別：

- 金額 → `numberValue`
- 日期 → `numberValue`（Sheets 序列值，1899-12-30 為 0）加日期格式，使日期函式與排序真的可用
- 其他全部 → `stringValue`

**不使用 `valueInputOption: USER_ENTERED`。** 備註與原始輸入是使用者自由輸入的文字，
若以 USER_ENTERED 寫入，一則以 `=`、`+`、`-`、`@` 開頭的備註會變成 Sheet 裡的**實際公式**。
明確指定 `stringValue` 讓公式注入在結構上不可能發生，而不是靠事後清洗。

## 5. 位置定址與 upsert

Sheets 是位置定址（A1 記法），**沒有原生 upsert**。要以 id 為鍵更新就得知道那筆在第幾列。

**做法：每次同步先讀一次各分頁的鍵欄（A 欄），在記憶體建 `id → 列號`，再批次寫需要改的列。
新的 id 附加到最後。**

Transactions 分頁**連日期欄（B 欄）一起讀**，也就是讀 `A:B` 而不是只讀 `A:A` ——
§3 的「受影響的月份」需要 Sheet 上的舊日期才能涵蓋跨月搬移。同一次呼叫，不增加成本。

多一次讀取呼叫，換到的是**自我修復**：不管列怎麼移動、有沒有人手動動過，下一次同步都會
對準。

被否決的兩個做法：

- **把 `id → 列號` 存在 SQLite**：省一次讀取，但列的位置一漂移就會寫錯列，而且錯了不會有
  任何人知道。對一個要拿來看的表，寫錯列比慢一點糟糕得多。
- **每次整張表重寫**：最簡單，但寫入量隨資料量線性成長。現在幾十筆無所謂，兩年後不行。

## 6. 認證與設定

**服務帳號（Service Account）。** 金鑰不過期、不需要瀏覽器同意流程、不需要 refresh token，
適合無人值守的容器。OAuth 的 refresh token 會因密碼變更、撤銷授權、長期未使用而失效，
失效時需要人工重新授權，而 bot 是背景服務。

使用者需要做的：GCP 建專案並啟用 Sheets API、建服務帳號並下載 JSON 金鑰、把試算表分享
給服務帳號 email（編輯權限）。

設定：

| 環境變數 | 用途 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | JSON 金鑰的**檔案路徑** |
| `SHEET_SPREADSHEET_ID` | 目標試算表 id |

金鑰以檔案掛進容器，**不以環境變數傳內容** —— 那會出現在 `docker inspect` 與行程清單裡。

**兩者皆未設定時整個鏡像功能關閉，bot 照常運作。** 這讓 M5a 可以先合併進 main 再從容接線。
只設其中一個視為設定錯誤，啟動時失敗並明確說明缺哪一個（沉默地半開啟比直接失敗糟）。

金鑰內容與 `SHEET_SPREADSHEET_ID` 都要加入 `src/logger.ts` 的遮罩清單。M4 的教訓是遮罩
清單只有被測試釘住的欄位才算數，因此這兩者各需一條經變異驗證的測試。

## 7. 失敗處理與升級

**AC-21 是結構性成立的**：帳本寫入路徑完全不碰 Sheets。Sheet 掛掉游標就不前進，不存在
「因為 Sheet 失敗而入帳失敗」。

### 配額

Sheets API 每使用者每分鐘 60 次寫入。設計上：

- **沒有變更就不打 API**（步驟 2 先查 SQLite）。閒置時每分鐘 0 次呼叫。
- 有變更時一次 tick 是 1 次讀 + 最多 3 次寫。tick 間隔 20 秒 → 最壞每分鐘 12 次，離 60 很遠。
- AC-22 要求「通常 1 分鐘內」，20 秒有兩倍餘裕。

「閒置時不打 API」是整個配額設計的基礎，**必須有測試釘住**（見 §9）。

### 暫時 vs 永久

| 類型 | 例子 | 處理 |
|---|---|---|
| 暫時 | 429、500、503、網路逾時 | 游標不動，下一輪自己追上。不需要佇列。 |
| 永久 | 403（沒分享給服務帳號）、404（試算表被刪）、400（範圍錯誤） | 會無聲地永遠重試 —— 必須升級 |

`consecutive_failures` 連續達到 **5** 次就升級：透過 Telegram 通知使用者一次，節流 10 分鐘
（沿用 M4 `notify-attention` 的形狀與節流鍵慣例，包含「只在送出成功時寫入節流時間」這條
已經裁決過的語意）。成功一次就把 `consecutive_failures` 歸零。

## 8. 可觀測性

**這一節同時收掉 `docs/todo/outbox-delivery-logging.md`。**

M4 驗收發現：刻意製造的整場遞送事故（斷網、反覆重試、用盡上限、升級、手動重試）在
`docker logs` 裡沒有留下任何一行。`/status` 顯示的是當下狀態，事故結束就不留痕跡，
因此事後答不出「這種情況發生過幾次」。

M5a 不重複這個錯，而且兩條管線用**同一套記錄慣例**：

- 同步失敗、重試、升級、恢復都寫日誌。
- 可以記：內部識別碼（`transaction_id`、`allocation_id`、分頁名）、錯誤類別與 HTTP 狀態、
  筆數、耗時。
- **不可以記**：訊息本文、財務原文、帳戶／商家／對象名稱、金額。遮罩由 `src/logger.ts`
  負責，但不得依賴它擋下本來就不該傳進去的東西。
- 一併補上 outbox 那三處缺的日誌（重試、放棄、告警自身失敗）。

`/status` 增加 Sheets 區段：最後成功同步時間、落後筆數、連續失敗次數、最後一個錯誤類別。

## 9. 測試策略

### 分層

**Port/adapter**：窄介面 `SheetsClient`，只有 `readKeyColumn(tab)` 與 `batchUpdate(writes)`。
`googleapis` 只出現在 adapter，`src/domain/` 與 `src/application/` 永不 import ——
與既有的 grammY 規則一致。

**替身必須是模擬器，不是樁。** 要真的模擬位置定址：列號、鍵欄、寫到超出現有範圍的行為。
否則「以鍵 upsert」在測試裡是恆真的，等於沒測。M4 有一個潛伏 bug 同時存在於真實實作與
測試替身裡，最後是靠 5 種情境的**差分測試**才證明兩者語意一致 —— 同樣的差分測試要做。

### 收斂性測試

這是方案 A 特有、而且比逐個函式測有力得多的測試：

1. 套用一串帳本異動 → 同步 → 斷言 Sheet 狀態等於 SQLite 的投影。
2. 同一批同步跑兩次 → 結果相同（冪等）。
3. 把 Sheet 弄亂（改值、刪列、插列）→ 跑校正 → 收斂回正確狀態。

### 對真實 Google Sheets 的整合測試

**替身證明不了我們對 Sheets 語意的理解是對的。** M4 最貴的一課：`scripts/backup.sh` 壞了
整整一個里程碑、510 條測試全綠，唯一發現它的原因是有人真的跑了一次。Mock 不會告訴你
`:ro` 在 WAL 下開不起來。

因此：`tests/integration/sheets.integration.test.ts`，對一張拋棄式試算表跑完整來回 ——
建列、改列、軟刪除、手動改亂再校正確認收斂。

- **不在 `pnpm check` 範圍內**，用 `pnpm test:sheets` 跑。理由只有一個：真實網路進了單元
  測試套件，套件就會隨機變紅，而一個會無故紅的套件三週後就沒人看，那比沒有套件更糟。
  配額不是問題（幾十次寫入對每分鐘 60 次很寬裕）。
- 憑證與拋棄式試算表 id 從環境變數來。**缺憑證時大聲跳過** —— 印出缺哪一個並讓指令非零
  退出。無聲跳過的整合測試就是另一種空轉守衛。
- 用 vitest 而不是 bash，因為斷言是收斂性比對；`backup-selftest.sh` 適合 bash 是因為它只
  要看離開碼。

### 驗收標準

沿用 M4：宣稱被保護的行為，都要附「把它改壞、對應測試變紅」的證據與失敗訊息原文。
自我宣稱不算數。

## 10. 通過條件

1. **AC-21**：Sheet 暫時失敗期間，入帳完全正常。
2. **AC-22**：Sheet 恢復後通常 1 分鐘內完成鏡像，且無重複列。
3. `pnpm check` **exit 0**。
4. **`pnpm test:sheets` 綠燈** —— 與 AC 並列，不是選配。任何動到 adapter 或欄位定義的
   變更，合併前必須跑過並在報告附結果。
5. 人工驗收：在真實 Sheet 上確認三張分頁的內容與可用性（能排序、能樞紐分析、金額能 SUM）。

## 11. 不做的事

- 雙向同步（Sheet 編輯寫回帳本）。設計不堵死這條路 —— 列的身分（id 在 A 欄）穩定可辨認，
  日後要偵測使用者編輯有依據 —— 但現在不做。
- Accounts、Categories、AuditLog 三張分頁。
- 分類細項的月度分頁（用樞紐分析）。
- Google Drive 備份（屬於 M5b）。
- 匯出與永久刪除（屬於 M5c）。

## 12. 一個已知後果：原始輸入與 AC-29

使用者決定 `raw_input_snapshot`（原句，例如「午餐 1260，小明欠 630」）**要**進 Sheet，
理由是核對解析結果時有用。

後果必須寫明：**Google Sheets 的版本歷史沒有 API 可以清除。** 原文一旦寫進去，即使之後
清空儲存格，仍留在版本歷史、離線快取與 Drive 回收桶裡。

因此 AC-29「永久刪除敏感原文」對 Sheets 這一側的唯一做法是**複製成新試算表（副本不帶
歷史）再刪掉舊的**，不是清空儲存格。這條要帶進 M5c 的設計，並且 M5c 的永久刪除流程必須
包含重建試算表與更新 `SHEET_SPREADSHEET_ID`。

帳本本體不受影響 —— 原文在 SQLite 裡照常可以真的刪除。
