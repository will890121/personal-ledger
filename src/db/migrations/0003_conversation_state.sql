CREATE TABLE batches (
  batch_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  item_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE drafts_v2 (
  draft_id TEXT PRIMARY KEY,
  draft_ref TEXT NOT NULL DEFAULT (lower(hex(randomblob(4)))),
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  batch_id TEXT REFERENCES batches(batch_id),
  batch_index INTEGER,
  occurred_date TEXT NOT NULL,
  amount TEXT,
  currency TEXT,
  status TEXT NOT NULL,
  pending_fields TEXT,
  draft_json TEXT NOT NULL,
  preview_chat_id TEXT,
  preview_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_date TEXT,
  updated_at TEXT,
  confirmed_transaction_id TEXT,
  UNIQUE (owner_id, draft_ref)
);

INSERT INTO drafts_v2 (
  draft_id, draft_ref, owner_id, request_id, source_event_id,
  occurred_date, amount, currency, status, draft_json,
  created_at, created_date, confirmed_transaction_id
)
SELECT
  draft_id,
  lower(hex(randomblob(4))),
  owner_id,
  request_id,
  source_event_id,
  occurred_date,
  amount,
  currency,
  status,
  draft_json,
  created_at,
  date(created_at),
  confirmed_transaction_id
FROM drafts;

DROP TABLE drafts;
ALTER TABLE drafts_v2 RENAME TO drafts;

ALTER TABLE transactions ADD COLUMN batch_id TEXT REFERENCES batches(batch_id);

CREATE INDEX drafts_owner_status_idx ON drafts(owner_id, status, created_at DESC);
CREATE INDEX drafts_preview_message_idx ON drafts(preview_chat_id, preview_message_id);
CREATE INDEX drafts_batch_idx ON drafts(batch_id);
