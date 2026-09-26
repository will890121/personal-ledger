# M3b 驗收證據

日期：2026-09-24

## 自動驗證

- `pnpm check`：通過，51 個測試檔、318 個測試全數通過；format、typecheck、lint 與 build 通過。
- Migration 0005：`allocations` 新增可空欄位 `recovers_allocation_id`（`REFERENCES allocations(allocation_id)`）與索引 `allocations_recovers_idx`、`allocations_purpose_idx`。`schema_migrations` 依序保留版本 1 至 5，重複執行冪等，`foreign_key_check` 無錯誤（`tests/db/migrate-advance-recovery.test.ts`）。既有 M3a 資料（草稿、`confirmed_transaction_id`、`batch_id`）經 migration 0005 後完整保留，未被本次變更觸及。
- 三種新帳務形狀（`outflow:advance`、`none:advance`、`inflow:advance_recovery`）通過領域驗證；`recovers_allocation_id` 只能出現在 `purpose=advance_recovery` 的配置、代墊必須有交易對象、回收金額不得超過代墊金額，均由 `tests/domain/advance.test.ts`、`tests/domain/ledger.test.ts` 覆蓋。
- AC-11（分帳建立）：`tests/parser/advance-flows.test.ts` 涵蓋一半／各半／N 個人平分、除不盡追問、明確金額（含全額代墊與超額矛盾）、信用卡代墊（`none:advance`）、未知交易對象追問與當場建立、多人分帳逐人追問。
- AC-12（部分回收）：`tests/application/record-recovery.test.ts` 涵蓋先進先出分配（一次沖抵多筆、部分沖抵）、回收配置繼承代墊的分類與交易對象。
- AC-13（放棄回收）：`tests/application/abandon-advance.test.ts` 涵蓋部分放棄（拆成已回收代墊與支出兩筆、配置合計不變）、全額放棄（直接轉為 `expense`、不拆分）、放棄後消費歸屬原交易日期、稽核事件含前後快照。
- AC-14（超額回收）：`tests/application/record-recovery.test.ts` 的 `"asks for a category when the payment exceeds the outstanding total"` 驗證超出部分自成一筆配置並追問分類，不自動歸類為收入、不沖抵其他對象。
- 刪除保護：`tests/db/sqlite-advances.test.ts` 驗證帶回收關聯的代墊交易無法被軟刪除；回收交易本身可軟刪除，刪除後對應代墊的未回收餘額自動回升。
- 未回收餘額與先進先出分配一律以 Decimal 計算（`src/domain/advance.ts` 的 `computeOutstanding`、`planRecovery`），`listAdvanceRows`／`listRecoveryRows` 只回傳原始列，不經 SQL `sum()` 聚合。
- 統計語意：`src/domain/ledger-summary.ts`（`summarizeAllocations`）自 M3b 分支起未被修改；`tests/domain/advance-summary.test.ts` 以固定資料證明代墊計入實際流出但不計入個人消費、回收計入實際流入但不計入個人收入，分類排名不含代墊。
- `/advances`：`tests/telegram/advances-command.test.ts` 涵蓋依交易對象分組、分頁與關閉清單、記錄收款的追問與短碼失效處理、放棄回收的二次確認與清單即時重繪、待回收狀態不劫持不相關的純數字或草稿回覆。
- 回收文字入口：`tests/telegram/recovery-input.test.ts` 涵蓋「小明還 300」「收到小明 300」「小明還我 300」三種寫法、對象沒有未回收代墊時的提示、以及一般敘述句（如「小明還欠我錢」）不被誤判為回收。
- 切分規則回歸集：`tests/fixtures/parser-corpus.ts` 共 38 筆匿名化語料（`tests/parser/corpus.test.ts`，39 個測試含最低筆數斷言），涵蓋 M2 既有語句、M3a 批次與合併規則、常見誤傳，以及本次新增的 11 筆 M3b 代墊／回收語句，全數通過，包含官方示例寫法「`午餐 1260，小明欠 630`」（逗號 + 指名金額）。
- `splitInput` 修正：純粹的欠款／代付子句（`X欠<金額>`、`要還<金額>`、`該給<金額>`、`幫X付<金額>`）即使帶著金額數字，也視為前一段的分帳明細併回同一筆交易，不再被誤切成獨立交易；一般兩筆各自完整的交易（如 `午餐 120，咖啡 60`）不受影響。由 `tests/parser/split-input.test.ts` 新增的 5 個測試釘住，含正向案例、回歸保護與「子句夾雜其他內容則不合併」的邊界案例。
- Docker Compose：`docker compose config --quiet` 通過。
- Docker image：`personal-ledger:m3b` 建置通過，image ID `1d7844cdeb4c`。
- Container startup：以測試 token、測試 owner ID、暫存 SQLite 路徑及 `LEDGER_STARTUP_CHECK=1` 啟動成功並正常結束，migration 0005 套用無誤。
- 最終全分支審查：以最強模型審查 33 個 commit 的完整 diff，提出 1 個 Critical 與 3 個 Important，全部修正並經範圍限定複審確認（詳見下方「最終審查發現與修正」）。

## 人工 Telegram 驗收

日期：2026-09-24 至 2026-09-25。於真實資料的複本上執行（`schema` 由 v4 升至 v5、7 筆交易與 12 筆草稿完整保留、`foreign_key_check` 乾淨），驗收結束後複本已刪除，正式帳本未留下任何測試資料。

- [x] AC-11：分帳建立。以 `聚餐 1260，我先付，朋友欠一半` 或等義語句建立交易，確認個人支出與代墊各半、代墊帶正確交易對象。
- [x] AC-12：部分回收。對同一對象登記一筆小於未回收總額的收款，確認回收預覽逐筆列出沖抵明細，確認後未回收餘額正確減少。
- [x] AC-13：放棄回收。對有剩餘餘額的代墊按「放棄回收」，確認二次確認文案顯示正確金額，確認後原月份個人消費增加、清單即時重繪、稽核事件可追溯。
- [x] AC-14：超額回收。登記一筆超過未回收總額的收款，確認超出部分另外追問分類，且不沖抵其他對象的代墊。
- [x] `/advances` 清單與操作：依交易對象分組顯示未回收總額與筆數，展開後逐筆顯示日期、原金額、已回收與餘額；分頁與「關閉清單」正常運作；重新呼叫會關閉前一份清單。
- [x] 多人平分的逐人追問：三人以上分帳且除不盡或未具名時，逐人追問交易對象或每人負擔金額，補齊後才完成草稿，且不同人不會被錯填同一個交易對象。
- [x] 未知對象的當場建立：分帳語句指名尚未建立的交易對象時，追問「要建立嗎？」並附按鈕；按下後建立並補完草稿；按「取消」不建立、不留下草稿。
- [x] 回收文字入口：直接打字「X還 <金額>」與「收到X <金額>」都能觸發回收預覽；對沒有未回收代墊的對象輸入時得到提示而非建立交易；一般敘述句不被誤判。
- [x] 容器重啟後仍可用：重啟後，`/advances` 舊清單的短碼按鈕、待回收提問的 reply 綁定仍然有效。

## 已知限制

- **阿拉伯數字人數的「N 個人平分」與金額掃描衝突（裁定不修）**：`COUNT_PATTERN` 的正則表達式支援 `[0-9]+ 個人平分`（如「3個人平分」），但 `parseAmountCandidates` 會把其中的阿拉伯數字誤認成第二個金額候選，導致落入既有的「金額不明」追問而非分帳路徑。中文數字寫法（「三個人平分」）不受影響。症狀是多一次追問，不會產生錯誤資料，嚴重度遠低於前述的分帳語意遺失問題；修法需要調整既有的金額掃描邏輯，在里程碑末期引入的風險大於效益，裁定不修，改由 README 要求使用中文數字。
- 不含金額的段落一律併回前一段，此為 M3a 既有規則，M3b 未變動。

## 最終審查發現與修正

全分支審查在 15 輪單任務審查之後執行，發現四項單任務審查照不到的接縫問題，均已修正並補上回歸測試：

1. **分帳路徑缺「待分類」後援殼（Critical）**：`聚餐 1260，我先付，朋友欠一半`（AC-11 官方語句）因為「聚餐」推導不出分類，分帳路徑回傳空配置而被降級為「無法解析」。非分帳路徑本有後援殼，分帳路徑漏了。已抽共用後援殼函式。此缺陷的語句**當時已在回歸語料中且為綠**——因為語料只斷言 `ParseResult` 的種類，區分不出「帶可用配置殼」與「帶空配置」。語料斷言已一併提升為同時檢查配置筆數。
2. **explicit 分帳路徑跨過退款與信用卡關卡（Important）**：`午餐 1260 刷卡，朋友欠 630` 被記成 `outflow:advance` 而非 `none:advance`，污染實際流出；同語意的「一半」寫法卻正確追問帳戶。已抽 guard 函式讓兩條路徑通過同一組關卡，並共用代墊配置建構函式。
3. **交易對象追問對新使用者是死路（Important）**：候選為空時只顯示「請選擇：」配空鍵盤，文案未提可回覆輸入新名稱。已補上指示。
4. **回收金額格式錯誤後的提示與行為矛盾（Important）**：訊息邀請重試，重試卻落入其他路徑產生垃圾草稿。已改為指引重新從 `/advances` 開始。

另新增 `tests/telegram/advance-chain.test.ts`，貫穿「建立分帳 → 確認入帳 → 部分回收 → 放棄剩餘」完整鏈路並斷言配置合計精確等於交易總額。先前每個任務只測自己那一段，沒有測試走過接縫。

## 結論

## 人工驗收發現並修正的缺陷

人工驗收找出六項自動測試、15 輪任務審查與全分支審查都沒抓到的缺陷。全部已修正並補上回歸測試：

1. **放棄回收在真實 SQLite 上必定崩潰（Critical）**：`updateTransaction` 以「刪除全部配置再重建」的方式寫回，而 migration 0005 的 `recovers_allocation_id` 是指向配置的外鍵，刪除瞬間即違反。觸發條件正是 AC-13（代墊 → 部分回收 → 放棄剩餘）。修法為在該 transaction 內啟用 `PRAGMA defer_foreign_keys`，把外鍵檢查延到 COMMIT。**未被測試抓到的原因**：`abandon-advance` 與端到端鏈路測試都使用 `FakeLedgerRepository`，測試替身沒有外鍵約束，這條路徑從未在真實 SQLite 上執行過。已補一組使用真實 `SqliteLedgerRepository` 的測試。
2. **任何未處理錯誤會讓整個 Bot 停止（Critical）**：grammy 在未註冊 `bot.catch` 時遇到 handler 拋錯會停止輪詢，使用者看到的是 Bot 從此完全不回應。此缺陷自 M1 起就存在，只是先前沒有 handler 拋過錯。已註冊 `bot.catch`，記錄脫敏後的錯誤並回覆可理解的提示，不再停止服務。
3. **超額回收的分類追問沒有脈絡**：只顯示「待補分類：小明還 700」，使用者無從得知 630 已沖抵、剩餘 70 才是待分類對象，也不知道沖抵的是哪一筆。已改為顯示沖抵金額、被沖抵代墊的日期與剩餘金額。
4. **多人分帳逐人追問的第一次點選毫無回應**：第二輪追問的訊息文字與第一輪完全相同，Telegram 回 `message is not modified`，錯誤被新加的 `bot.catch` 吞掉，使用者以為沒生效而重複點選，兩筆代墊因此靜默歸給同一人。已讓每輪追問帶「第 N 位，共 M 位」的進度資訊，並將該錯誤視為良性。
5. **預覽看不出每筆代墊的債務人**：多人分帳時無法在確認前發現指派錯誤。已在配置明細顯示交易對象。
6. **`bot.catch` 的日誌過度脫敏**：只記錄錯誤類別名稱，導致第 4 項的診斷必須靠推測。已對 `GrammyError` 額外記錄 Telegram 回傳的 `error_code` 與 `description`（API 層描述，不含使用者輸入或財務資料）。

另依使用者要求調整交易預覽版型為樹狀縮排（欄位順序改為「資金效果 · 用途 (交易對象)」），四種候選版型與取捨記錄於 [`docs/design/preview-layouts.md`](../design/preview-layouts.md)，日後預計做成 `/settings` 的偏好設定。

## 結論

自動驗證、程式審查與人工 Telegram 驗收全部通過，M3b 完成。

人工驗收的六項發現全數屬於「自動測試照不到」的類別：測試替身與真實資料庫的行為差異、框架預設的錯誤處理、以及「程式正確但使用者看不懂」的呈現問題。這一輪的經驗支持在後續里程碑補上 Fake 與真實 repository 的共用契約測試。「已知限制」列出的阿拉伯數字人數問題裁定不修，已於 README 註明替代寫法。
