# M3a 批次與對話狀態設計

- 日期：2026-09-21
- 狀態：待核准
- 里程碑：M3a－批次與對話狀態

## 1. 目的

M3a 讓一則訊息可以產生多筆草稿，並讓解析不完整的草稿留在系統中等待補充，而不是被丟棄。本設計涵蓋路線圖驗收案例 AC-09 與 AC-10，以及 `/pending` 與草稿封存。

M3 原本合併了批次、對話狀態與代墊回收三塊。代墊回收（AC-11 至 AC-14、`/advances`）獨立為 M3b，在 M3a 驗收通過後另行設計。兩者的相依方向是單向的：M3b 會用到 M3a 的批次與候選選擇機制，M3a 不需要知道代墊存在。

## 2. 範圍

M3a 包含：

- 一則訊息切分為最多 10 筆草稿，共用 `batch_id` 與來源事件；
- 不完整草稿的領域型別、持久化與升級路徑；
- 欄位追問，以候選按鈕為主、金額文字回覆為輔；
- reply 指定草稿，以及未指定草稿時的候選選擇；
- 永久保存的待處理清單 `/pending` 與手動封存；
- 跨日草稿的重新預覽規則。

M3a 不包含：代墊與回收、借貸、自然語言修改、AI 解析、持久化背景工作、Google Sheets 同步、`needs_attention` 自動化處理。`/pending` 的「同步失敗」分組待 M5 有 Sheet 同步後才存在。

## 3. 決策摘要

| 決策 | 選擇 | 理由 |
|---|---|---|
| 追問形式 | 可枚舉欄位用候選按鈕，金額用 reply 文字 | 按鈕零歧義且不經過解析器；金額是連續值，按鈕不實際 |
| 過期草稿 | 建立日不等於今日即過期，舊按鈕不入帳，改重發預覽 | 記帳心智模型以日為單位；固定 `today` 即可測試，無須時間軸 |
| 無法解析的輸入 | 不建草稿，只回覆範例 | 避免誤傳與錯字累積成需要手動封存的待辦；InputEvent 仍完整保留 |
| 切分規則 | 以 `，` `,` `、` 換行切分，不含金額的段落併回前一段 | 單一規則同時滿足 AC-09、M2 的手續費語句與 M3b 的代墊語句 |
| 無 reply 的文字 | 先當新交易解析，失敗才視為補欄位 | 不讓舊草稿攔截新的記帳輸入 |
| 對話狀態位置 | 全部長在 `drafts` 列上，不另建會話實體 | 單一真相來源；重啟後行為一致，無須恢復邏輯 |

## 4. 資料模型

### 4.1 兩種草稿型別

領域層區分不完整與可確認兩種草稿：

- `IncompleteDraft`：`amount`、`allocations`、分類等欄位皆可缺，額外帶 `pendingFields`，記錄缺哪些欄位及該欄位的候選 ID。它沒有確認路徑。
- `TransactionDraft`：維持 M2 現狀，所有不變條件（配置合計等於總額、帳務形狀白名單）不變。

唯一的升級入口是補欄位後重新驗證。驗證通過才產生 `TransactionDraft`，因此「不完整的草稿被確認入帳」在型別層面即不可能，不依賴執行期檢查。升級失敗時不覆寫既有草稿。

### 4.2 Migration 0003

| 異動 | 內容 |
|---|---|
| 新表 `batches` | `batch_id`、`owner_id`、`source_event_id`、`item_count`、`created_at` |
| 重建 `drafts` | `amount` 與 `currency` 改為可空；新增 `batch_id`、`batch_index`、`draft_ref`、`pending_fields`、`preview_chat_id`、`preview_message_id`、`updated_at` |
| `transactions` 新增 `batch_id` | 可空，外鍵指向 `batches`；既有資料保留 NULL |
| 新增索引 | `drafts(owner_id, status)`、`drafts(preview_chat_id, preview_message_id)`、`drafts(batch_id)` |

SQLite 無法直接放寬 `NOT NULL`，`drafts` 比照 migration 0002 的重建手法處理：建新表、搬資料、換名。重建必須保留既有草稿與 `confirmed_transaction_id`，且 `transactions.draft_id` 外鍵在遷移後仍然成立。

`draft_ref` 是 8 字元十六進位短識別，同一擁有者內唯一，只用於 callback 與清單顯示。`pending_fields` 以 JSON 保存 `{ field, candidateIds }` 陣列。

`drafts.status` 不新增值。M1 已定義的八個狀態中，M3a 讓 `awaiting_input` 與 `archived` 第一次實際被使用；`needs_attention` 保留給 M4。

## 5. 批次解析管線

一則訊息對應一個 InputEvent 與一個 `batches` 列。即使只解析出一筆也建立批次，使「訊息 → 批次 → 草稿」維持單一路徑。冪等性沿用 `input_events.telegram_update_id` 的唯一約束。

管線分為三個階段，每階段可獨立測試：

```text
text ──split-input──▶ segments[] ──rule-parser──▶ ParseResult[] ──create-batch──▶ drafts[] + 回覆
```

1. `split-input`：純字串處理，不認識帳務語意。以 `，` `,` `、` 及換行切分，再把不含金額的段落併回前一段；首段不含金額時併入後一段，因為沒有可併回的前段。併回後只剩一段即為單筆。
2. `rule-parser`：簽名不變，仍是一段文字對應一個 `ParseResult`。`missing_fields` 這個 variant 必須帶上已解析出的部分內容，否則無法建立保留既有資訊的 `IncompleteDraft`。
3. `create-batch`：記錄 InputEvent、切分、逐段解析、組裝草稿，並以單一 SQLite transaction 寫入整批。

併回後的段落超過 10 個時整則拒絕，不建立任何草稿，回覆要求拆分。半批入帳比要求重新輸入更難收拾。

部分失敗依段落結果分三類，彼此不影響：

- 完整：存為 `awaiting_confirmation`，各發一則預覽；
- 缺欄位：存為 `awaiting_input`，各發一則追問；
- 完全無法解析：不建草稿，僅在批次摘要中列出原文片段。

批次含兩段以上時，最後追加一則摘要訊息，說明各狀態筆數。

寫入先於發送訊息。若在兩者之間中斷，草稿已持久化並可由 `/pending` 取得，因此 `preview_message_id` 必須可空並於發送後補寫。M3a 沒有背景重試，但不遺失資料。

## 6. 追問與路由

### 6.1 callback 編碼

Telegram 的 `callback_data` 上限為 64 bytes。既有的 `delete-confirm:<uuid>` 為 51 bytes，而「草稿加欄位加候選」若直接串接兩個 UUID 會超出上限並在發送時失敗。

因此 callback 不攜帶 UUID，只攜帶 `draft_ref`、欄位與候選索引，例如 `f:a7k2m9x4:cat:2`，約 18 bytes。候選清單持久化在 `pending_fields`，解碼一律查資料庫。候選清單必須持久化，否則重啟後舊按鈕無法對應到原本的選項。

### 6.2 四條入口

| 入口 | 路由依據 |
|---|---|
| 候選按鈕 | callback 中的 `draft_ref`、欄位與索引 |
| reply 預覽訊息 | `reply_to_message_id` 反查 `drafts.preview_message_id` |
| 無 reply 的文字 | 純數字且有草稿正在等金額時，列出那些草稿供指定；其餘一律當新交易解析 |
| `/pending` 點選 | 同候選按鈕 |

四條入口收斂到同一個應用層函式 `answerDraft`。該函式記錄 InputEvent（callback 同樣是不可變輸入事件）、填入欄位值、重新驗證。驗證通過即升級為 `TransactionDraft` 並重發完整預覽；仍有缺漏則繼續追問下一個欄位。

即使只有一筆 `awaiting_input` 草稿，未指定草稿的文字仍需使用者明確選擇，不自動套用。

純數字訊息必須在建立批次**之前**攔截。`120` 這種輸入本身會被解析成一筆缺分類的草稿，若先建批次就永遠走不到候選清單，還會留下使用者沒有要的草稿。攔截條件是「訊息只有數字」且「存在正在等金額的草稿」；兩者不同時成立時，一律照新交易處理。

### 6.3 過期草稿

確認 callback 的第一步檢查草稿建立日（使用者時區）是否為今日。不是今日即不入帳，改為重發完整預覽並要求再次確認。預覽必須重新顯示建立日、金額與解析結果。此規則只實作於一處。

草稿的 `occurred_date` 沿用建立當時的解析結果，不因延後確認而改變。

## 7. 待處理清單與生命週期

`/pending` 依狀態分為兩組：等待補充（`awaiting_input`）與等待確認（`awaiting_confirmation`），各組依建立時間由新到舊排列，每頁最多 10 筆。分頁沿用 M2 `/recent` 的 callback 分頁模式。

每筆項目提供三個動作：繼續補欄位、重新預覽、封存。

草稿不自動刪除，也不自動封存。封存是使用者明確動作，只把草稿移出 `/pending` 預設清單，不刪除草稿本身，也不刪除來源事件。`cancelled` 表示使用者在預覽時主動取消；`archived` 表示擱置已久的項目被收起。兩者都是終止狀態，差別只在語意與來源。

過期草稿仍然出現在 `/pending`，可經由重新預覽恢復操作。

## 8. 模組邊界

新增：

- `src/parser/split-input.ts`：純函式切分。
- `src/application/create-batch.ts`：批次建立，取代 `create-draft.ts` 的對外角色。
- `src/application/answer-draft.ts`：補欄位與升級。
- `src/application/list-pending.ts`：待處理查詢。
- `src/telegram/callback-data.ts`：callback 編解碼，純函式。
- `src/telegram/format-prompt.ts`：追問訊息與候選鍵盤。

`create-bot.ts` 目前 444 行，M3a 會再加入批次、追問與 `/pending` 三組 handler。設計包含一次有界拆分：handler 依主題分檔，`create-bot.ts` 只保留組裝與白名單守衛。此拆分僅涵蓋 M3a 會動到的範圍，不擴及無關程式。

領域與應用層不得引用 grammy 型別。Telegram 專屬概念（`message_id`、`callback_data`）只出現在 `src/telegram/` 與 repository 的欄位對應。

## 9. 測試策略

- **純函式表格測試**：`split-input` 的切分矩陣（含 AC-09 語句、M2 手續費語句、M3b 代墊語句）；`callback-data` 編解碼，並斷言所有產生的 payload 不超過 64 bytes。
- **領域**：`IncompleteDraft` 升級成功與失敗；不完整草稿沒有確認路徑。
- **解析器**：`missing_fields` 帶回部分內容；既有 M2 語句行為不變。
- **Repository**：整批草稿的原子寫入；`preview_message_id` 反查；`/pending` 分組查詢；migration 0003 保留既有草稿與交易、外鍵完整、重複啟動冪等。
- **應用層**：部分失敗的三種分類；超過 10 段整則拒絕；`answerDraft` 四條入口收斂到相同結果。
- **Telegram**：沿用 M2 的 fake bot 模式，覆蓋 AC-09、AC-10、過期草稿不入帳、reply 路由、無 reply 數字的候選列表。
- **解析回歸集**：建立 20 至 30 條匿名化真實輸入的語料，置於 `tests/fixtures/parser-corpus.ts`。M3a 先以現有支援語句建立，M3b 再補代墊語句。此為路線圖列出的 M3 通過條件。

所有測試先寫失敗案例再實作，沿用既有 TDD 節奏。

## 10. 驗收對應

| 案例 | 語句 | 預期 |
|---|---|---|
| AC-09 | `午餐 120，Uber 245` | 兩筆獨立草稿，共用同一 `batch_id` 與來源事件，各自可獨立確認或取消 |
| AC-10 | `午餐 120，Uber 245，咖啡 90` | 兩筆正常預覽，第三筆存為 `awaiting_input` 並發出分類追問，補齊後升級並可確認 |

切分規則有一個必然後果：不含金額的段落一律併回前一段，因此一則多段訊息裡的某一段**不可能**單獨「缺金額」——`午餐 120，咖啡` 會合併成一段。AC-10 因此以缺分類的段落驗收，部分失敗的語意完全相同。缺金額的追問仍然存在，但由單段訊息產生，例如單獨傳「午餐」。

已知缺陷：`午餐 120，咖啡` 會被視為一筆 120 元的午餐，「咖啡」只是原文的一部分。使用者可在預覽時看出並取消，因此不會造成錯誤入帳。是否以關鍵字放寬合併規則，留待 M6 dogfood 依實際誤判頻率決定。

規格書的 AC-09 原句為 `午餐 120，咖啡 60`。M2 的參照資料沒有「咖啡」這個分類或商家，而解析器對未知參照一律不猜測，因此該句的正確行為是一筆草稿加一筆待補分類的追問，屬於 AC-10 的路徑而非 AC-09。驗收改用兩個皆可解析的段落來檢驗批次語意；`咖啡 60` 則作為缺分類追問的驗收案例保留。規格書不因此修改，因為兩者的行為都符合既有的「未知參照不猜測」原則。

通過條件另包含：`/pending` 正確分組並可封存；跨日草稿的舊按鈕不入帳；`pnpm check` 全數通過；Docker 啟動後 migration 0003 成功且既有 M2 資料完整。

## 11. 風險與取捨

- **切分誤判**：分隔符切分是啟發式規則。緩解方式是「不含金額即併回前一段」這條單一規則，以及把 M2 與 M3b 的既有語句納入回歸集，確保改動不會破壞既有行為。
- **`drafts` 欄位變寬**：把對話狀態放進草稿列，代價是欄位增加。相對於維護第二份會漂移的會話狀態，此代價可接受。
- **無背景重試**：發送訊息失敗時不自動重試，使用者需由 `/pending` 取回。持久化工作佇列是 M4 的範圍，M3a 不提前實作。
- **候選按鈕過長**：分類數量成長後鍵盤會過長。M3a 以每頁 10 筆分頁處理；智慧排序與常用優先留待有真實使用資料後再談。

## 12. 對 M3b 的預留

M3a 完成後，M3b 只需要新增代墊語意，不需要重建任何機制：

- 拆分語句（`聚餐 1260，我先付，朋友欠一半`）在 M3a 的切分規則下已經是單一段落；
- 「個人負擔或代墊金額不明必須追問」直接使用 `pendingFields` 與候選按鈕；
- 回收候選（依對象與未回收餘額）重用 `/pending` 的清單與分頁模式；
- `advance` 與 `advance_recovery` 屆時加入帳務形狀白名單，並新增 `advance_recovery_of` 關聯類型。
