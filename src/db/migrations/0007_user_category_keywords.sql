-- 使用者自訂的分類關鍵字：讓「牛排」「一蘭拉麵」這類 category-keywords.ts 內建表不認得
-- 的詞，由使用者教一次就記住，等於在執行期擴充那張表。
--
-- 刻意不記進 merchants：殘餘文字偵測只知道「這個詞我不認得」，分不出「一蘭拉麵」是店名
-- 而「牛排」是品項。把品項寫進 merchants 會讓預覽與 /recent 出現「商家：牛排」，污染
-- 商家這個概念。merchants 維持只放真正的商家。
--
-- subcategory 不另存欄位：沿用內建表的形狀，關鍵字本身就是品項（牛排 → 餐飲／牛排）。
CREATE TABLE user_category_keywords (
  keyword_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  -- 比對用的正規化字串，與 merchants／counterparties 同一套做法。
  normalized_keyword TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(category_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, normalized_keyword)
);

CREATE INDEX user_category_keywords_owner_idx ON user_category_keywords(owner_id);
