-- M2 把午餐種成「支出」底下的第二層葉分類，於是「午餐」和交通、購物平級成了主分類，
-- parser 又在上面補一個同名的 subcategory，預覽因此印出「午餐／午餐」。
--
-- depth 被 CHECK 限在 1|2，沒有第三層可用，所以正確的表達是讓葉分類回到「餐飲」這一
-- 層，餐別（早餐／午餐／晚餐）由 allocations.subcategory 承載——subcategory 這個欄位
-- 本來就是為這件事存在的，M1 原本也是這樣記。
--
-- category_id 刻意保持原值 'm2:<owner>:expense_dining_lunch'：
--   * allocations.category_id 有外鍵指著它
--   * 未確認草稿的 draft_json 裡嵌著同一個 id
-- 改 id 必須連帶重寫上述兩者，而 id 是不透明識別碼，改了換不到任何好處。
-- key 與 name 才是對外可見的部分，只改這兩個。
UPDATE categories
SET key = 'expense_dining', name = '餐飲'
WHERE key = 'expense_dining_lunch';

-- 既有 allocations 的 category_snapshot／subcategory_snapshot 一律不動：快照的用途
-- 就是保存交易當時的分類樣貌，migration 改寫它等於篡改歷史。
