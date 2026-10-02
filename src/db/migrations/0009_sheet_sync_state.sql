-- Sheets 鏡像的游標與健康狀態。一個 owner 一列，三張分頁共用同一個游標：
-- 三張分頁在同一輪裡一起寫，任何一張失敗就整輪不推進，下一輪三張全部重做。
-- 因為以 id 為鍵的 upsert 是冪等的，重做的代價是零；一頁一個游標只會讓三頁的
-- 進度各自漂移，換來的好處不存在。
CREATE TABLE sheet_sync_state (
  owner_id              TEXT PRIMARY KEY,
  -- 游標是 (updated_at, transaction_id) 兩欄，比較採字典序。兩者皆為 NULL 代表
  -- 從未同步過，下一輪會走全表校正。
  cursor_updated_at     TEXT,
  cursor_transaction_id TEXT,
  last_success_at       TEXT,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_reconciled_at    TEXT
);
