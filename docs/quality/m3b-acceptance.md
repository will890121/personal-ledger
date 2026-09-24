# M3b 驗收證據

日期：2026-09-24

## 自動驗證

- `pnpm check`：通過，48 個測試檔、294 個測試全數通過；format、typecheck、lint 與 build 通過。
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
- Docker Compose 設定檢查與 image 建置、容器啟動檢查（migration 0005 套用後正常結束）：**本次未執行**。這兩項需要存取 Docker daemon，依安排由審查者在後續統一處理，非本文件涵蓋範圍內的疏漏。

## 人工 Telegram 驗收

**尚未執行。** 本文件所在的環境沒有可操作的真實 Telegram Bot，以下清單維持未勾選，待審查者於真實資料的複本上逐項執行後回填結果（驗收結束後複本須刪除，正式帳本不得留下測試資料）：

- [ ] AC-11：分帳建立。以 `聚餐 1260，我先付，朋友欠一半` 或等義語句建立交易，確認個人支出與代墊各半、代墊帶正確交易對象。
- [ ] AC-12：部分回收。對同一對象登記一筆小於未回收總額的收款，確認回收預覽逐筆列出沖抵明細，確認後未回收餘額正確減少。
- [ ] AC-13：放棄回收。對有剩餘餘額的代墊按「放棄回收」，確認二次確認文案顯示正確金額，確認後原月份個人消費增加、清單即時重繪、稽核事件可追溯。
- [ ] AC-14：超額回收。登記一筆超過未回收總額的收款，確認超出部分另外追問分類，且不沖抵其他對象的代墊。
- [ ] `/advances` 清單與操作：依交易對象分組顯示未回收總額與筆數，展開後逐筆顯示日期、原金額、已回收與餘額；分頁與「關閉清單」正常運作；重新呼叫會關閉前一份清單。
- [ ] 多人平分的逐人追問：三人以上分帳且除不盡或未具名時，逐人追問交易對象或每人負擔金額，補齊後才完成草稿，且不同人不會被錯填同一個交易對象。
- [ ] 未知對象的當場建立：分帳語句指名尚未建立的交易對象時，追問「要建立嗎？」並附按鈕；按下後建立並補完草稿；按「取消」不建立、不留下草稿。
- [ ] 回收文字入口：直接打字「X還 <金額>」與「收到X <金額>」都能觸發回收預覽；對沒有未回收代墊的對象輸入時得到提示而非建立交易；一般敘述句不被誤判。
- [ ] 容器重啟後仍可用：重啟後，`/advances` 舊清單的短碼按鈕、待回收提問的 reply 綁定仍然有效。

## 已知限制

- **阿拉伯數字人數的「N 個人平分」與金額掃描衝突（裁定不修）**：`COUNT_PATTERN` 的正則表達式支援 `[0-9]+ 個人平分`（如「3個人平分」），但 `parseAmountCandidates` 會把其中的阿拉伯數字誤認成第二個金額候選，導致落入既有的「金額不明」追問而非分帳路徑。中文數字寫法（「三個人平分」）不受影響。症狀是多一次追問，不會產生錯誤資料，嚴重度遠低於前述的分帳語意遺失問題；修法需要調整既有的金額掃描邏輯，在里程碑末期引入的風險大於效益，裁定不修，改由 README 要求使用中文數字。
- 不含金額的段落一律併回前一段，此為 M3a 既有規則，M3b 未變動。

## 結論

自動驗證全部通過（`pnpm check` 全綠、AC-11 至 AC-14 對應的自動測試通過、刪除保護與統計語意雙口徑均有測試覆蓋，含 `splitInput` 遺失代墊語意問題的修正與回歸測試）。Docker 建置與容器啟動檢查、以及人工 Telegram 驗收尚未執行，M3b 在這三項完成前不算結案。「已知限制」列出的阿拉伯數字人數問題裁定不修，已於 README 註明替代寫法。
