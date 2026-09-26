# 分類模型

狀態：已實作（2026-09-26，migration 0006）

## 兩個層級

分類只有兩層，`categories.depth` 被 CHECK 限制在 `1|2`：

| 層級 | 內容 | 儲存位置 |
|---|---|---|
| depth 1 | 「支出」「收入」兩個根 | `categories` |
| depth 2 | **分類**：餐飲、交通、購物、居住、娛樂、醫療、學習、人情、旅遊、金融費用、其他支出、待分類 | `categories` |
| —— | **品項**：早餐、午餐、晚餐、捷運、電影… | `allocations.subcategory`（自由字串） |

depth 1 其實與 `allocations` 的 `kind` 重複，真正可用的分類層級只有一層；品項因此落在
`subcategory`。這與 M1 的表達方式一致（M1 記的就是 `餐飲` + `午餐`），只是 M2 之後
「哪些分類存在」由 `categories` 管理，品項仍是自由字串。

## 為什麼「午餐」不是分類

M2 把午餐種成 depth 2 的葉分類，於是「午餐」與交通、購物平級，而 parser 又在上面補一個
同名的 `subcategory`，預覽因此印出「午餐／午餐」。

migration `0006_dining_category.sql` 把那一列改名為 `expense_dining` / 餐飲。**`category_id`
刻意不變**（升級上來的帳本仍是 `m2:<owner>:expense_dining_lunch`）：`allocations.category_id`
有外鍵指著它，未確認草稿的 `draft_json` 裡也嵌著同一個 id，改 id 要連帶重寫這兩者，而 id
是不透明識別碼，改了換不到任何好處。

由此產生一條規則：**key 才是分類在一個帳本裡的邏輯身分**（`UNIQUE (owner_id, key)`），
`category_id` 只是識別碼，且同一個分類在不同安裝裡的 id 並不相同：

| 安裝方式 | 餐飲分類的 category_id |
|---|---|
| 由 M1 升級 | `m2:<owner>:expense_dining_lunch`（0002 建、0006 改名） |
| 全新安裝 | `m2:<owner>:expense_dining`（bootstrap 種） |

`SqliteReferenceRepository.saveCategory` 與 `ensureLegacyCategory` 都必須先按 key 查既有分類、
沿用它自己的 id。只看 `category_id` 判斷衝突的話，`INSERT OR IGNORE` 會被
`UNIQUE (owner_id, key)` 靜靜吃掉，接著回傳一個不存在的 id，下一步寫 allocation 就踩外鍵。

## 分類怎麼決定

`src/parser/category-keywords.ts` 是關鍵字 → 分類的對照表，`expenseShell` 依下列順序決定：

1. **商家**：句子命中已登記的商家，且該商家在商家對照表裡有分類（目前只有 `Uber → 交通`）。
   商家是比關鍵字更強的訊號。
2. **關鍵字**：對照表裡「包含於句子且最長」的那一筆；長度相同時依表序。
3. **都對不上**：回空陣列，交給 `fallbackExpenseShell` 的「待分類」殼去追問分類。

**帳戶不參與分類判斷。** M2 的版本是「沒有關鍵字但有帳戶就預設午餐」，於是
「早餐 100 現金」「國泰卡刷 1200」被靜靜記成午餐，而且欄位齊全、連追問都沒有，直接送上
預覽等使用者按確認。猜錯又不告知，比追問一次糟得多。帳戶只決定 `fundsEffect`
（信用卡 → `none`，其餘 → `outflow`）。

對照表裡刻意只放餐別與明確品類，不放店名或細品項（「一蘭拉麵」「珍奶」）。表一膨脹就
變成替使用者猜測，那個需求的正解是 `docs/todo/merchant-memory.md`。

## 名稱的單一來源

`src/domain/category-catalog.ts` 是「哪些分類存在、各自叫什麼」的唯一來源，bootstrap 用它
種資料、parser 用它在沒有參考資料時決定分類名稱。兩邊各寫一份是「午餐／午餐」躲過所有
測試的原因：測試替身把午餐葉分類命名為「餐飲」，生產環境卻是「午餐」，因此只有真實資料庫
會出現重複。`category-keywords.ts` 在模組載入時就驗證每個 `categoryKey` 都存在於 catalog。

## 已知限制

- **子字串比對沒有詞界**。中文沒有空白分詞，因此「幫朋友加油打氣 100」會命中「加油」而
  被判成交通，且不會追問。這類誤判在記帳語句裡頻率低，目前接受；真要收斂需要斷詞，
  代價遠高於收益。
- 品項（`subcategory`）沒有正規化清單，統計只能按分類彙總。
- `bootstrapReferenceData` 寫入葉分類時，`parentId` 仍是用 `m2:<owner>:expense` 這個樣板
  組出來的，而不是按 key 查根分類。目前不會出錯（migration 0002 與 `ensureLegacyCategory`
  用的都是同一個字串）；若哪天根分類的 id 不同，bootstrap 會以 `FOREIGN KEY constraint
  failed` 整批失敗、不寫入任何東西——會壞，但壞得很大聲，不會產生半套資料。
- migration 0006 假設一個帳本不會同時擁有 `expense_dining_lunch` 與 `expense_dining` 兩個
  key。人工造出這個狀態的話，migration 會以 `UNIQUE constraint failed` 整份 rollback 並停在
  版本 5，不會半途升級。出貨的程式走不到這個狀態（0006 必定早於新版 bootstrap）。
- 追問分類的候選按鈕上限是 `format-prompt.ts` 的 `MAX_CANDIDATES`。它必須大於實際的
  depth 2 支出分類數，否則「不猜、改追問」這條路自己表達不出完整的分類表；分類追問只
  接受按鈕，文字回覆會被當成金額退回，使用者會無路可走。`format-prompt.test.ts` 用
  `expenseCategoryLeaves` 咬住「每個分類都有按鈕」。
