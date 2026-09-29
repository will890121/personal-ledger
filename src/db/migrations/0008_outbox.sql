-- 帳本變更與「要送給使用者的那一則訊息」必須在同一個 transaction 裡提交，否則行程在兩者
-- 之間死掉就會出現「帳記了、人不知道」。這張表存的是已經渲染好的訊息，不是稍後重新渲染
-- 的參照：崩潰重啟後重新渲染可能得到不同輸出，但使用者該收到的是當初那一則。
--
-- 這不是通用工作佇列。規格 §16.1 列的五類工作裡，Sheet 同步與備份在 M5、AI 在 M7，
-- M4 只有「Telegram 遞送」這一個真實消費者。M5 帶來第二個消費者時再抽成多型別。
CREATE TABLE outbox_messages (
  message_id        TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  -- 這一則訊息是哪一種帳本變更造成的，供 /status 與事後追查
  cause             TEXT NOT NULL CHECK (cause IN (
                      'transaction_confirmed', 'recovery_recorded', 'advance_abandoned',
                      'transaction_updated', 'transaction_deleted')),
  chat_id           TEXT NOT NULL,
  -- 有值＝編輯既有訊息，NULL＝送一則新訊息
  target_message_id TEXT,
  text              TEXT NOT NULL,
  -- grammY 的 InlineKeyboardMarkup，以 JSON 字串保存
  reply_markup      TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'needs_attention')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  -- 有值且未過期＝有人正在送這一列。單一行程也需要它：擋住「提交後的快速路徑」
  -- 與「背景迴圈」同時送同一列。
  lease_expires_at  TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at      TEXT
);

CREATE INDEX outbox_pending_idx ON outbox_messages(status, next_attempt_at);
