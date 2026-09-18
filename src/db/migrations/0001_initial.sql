CREATE TABLE input_events (
  event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  telegram_update_id TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  occurred_date TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_transaction_id TEXT
);

CREATE TABLE transactions (
  transaction_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(draft_id),
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  occurred_date TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'confirmed'),
  confirmed_at TEXT NOT NULL
);

CREATE TABLE allocations (
  allocation_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
  funds_effect TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT
);

CREATE INDEX transactions_owner_confirmed_at_idx
  ON transactions(owner_id, confirmed_at DESC);
