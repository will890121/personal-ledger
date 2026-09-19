CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'credit_card', 'e_wallet')),
  currency TEXT NOT NULL CHECK (currency = 'TWD'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, normalized_name)
);

CREATE TABLE categories (
  category_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
  parent_id TEXT REFERENCES categories(category_id),
  depth INTEGER NOT NULL CHECK (depth IN (1, 2)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, key),
  CHECK ((depth = 1 AND parent_id IS NULL) OR (depth = 2 AND parent_id IS NOT NULL))
);

CREATE TABLE merchants (
  merchant_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, normalized_name)
);

CREATE TABLE counterparties (
  counterparty_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, normalized_name)
);

CREATE TABLE tags (
  tag_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, normalized_name)
);

INSERT INTO categories (category_id, owner_id, key, name, kind, depth)
SELECT 'm2:' || owner_id || ':expense', owner_id, 'expense', '支出', 'expense', 1
FROM transactions
GROUP BY owner_id;

INSERT INTO categories (category_id, owner_id, key, name, kind, parent_id, depth)
SELECT
  'm2:' || owner_id || ':expense_dining_lunch',
  owner_id,
  'expense_dining_lunch',
  '午餐',
  'expense',
  'm2:' || owner_id || ':expense',
  2
FROM transactions
GROUP BY owner_id;

INSERT OR IGNORE INTO categories (
  category_id, owner_id, key, name, kind, parent_id, depth
)
SELECT
  'legacy:' || t.owner_id || ':' || lower(hex(a.category || char(0) || coalesce(a.subcategory, ''))),
  t.owner_id,
  'legacy_' || lower(hex(a.category || char(0) || coalesce(a.subcategory, ''))),
  CASE WHEN a.subcategory IS NULL THEN a.category ELSE a.category || '／' || a.subcategory END,
  'expense',
  'm2:' || t.owner_id || ':expense',
  2
FROM allocations a
JOIN transactions t ON t.transaction_id = a.transaction_id
WHERE NOT (
  a.category IN ('food', '餐飲') AND a.subcategory IN ('meal', '午餐')
);

CREATE TABLE transactions_v2 (
  transaction_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(draft_id),
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  occurred_date TEXT NOT NULL,
  occurred_time TEXT,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'TWD'),
  account_from_id TEXT REFERENCES accounts(account_id),
  account_to_id TEXT REFERENCES accounts(account_id),
  merchant_id TEXT REFERENCES merchants(merchant_id),
  counterparty_id TEXT REFERENCES counterparties(counterparty_id),
  note TEXT,
  raw_input_snapshot TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'deleted')),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO transactions_v2 (
  transaction_id, draft_id, owner_id, request_id, source_event_id,
  source_type, source_ref, occurred_date, amount, currency,
  raw_input_snapshot, status, confirmed_at, created_at, updated_at
)
SELECT
  t.transaction_id,
  t.draft_id,
  t.owner_id,
  t.request_id,
  t.source_event_id,
  e.source_type,
  e.source_ref,
  t.occurred_date,
  t.amount,
  t.currency,
  substr(e.raw_text, 1, 4096),
  t.status,
  t.confirmed_at,
  t.confirmed_at,
  t.confirmed_at
FROM transactions t
JOIN input_events e ON e.event_id = t.source_event_id;

CREATE TABLE allocations_v2 (
  allocation_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions_v2(transaction_id) ON DELETE RESTRICT,
  funds_effect TEXT NOT NULL CHECK (funds_effect IN ('inflow', 'outflow', 'internal', 'none')),
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'income', 'expense', 'transfer', 'refund', 'advance',
      'advance_recovery', 'loan_out', 'loan_in', 'loan_repayment', 'fee'
    )
  ),
  amount TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'TWD'),
  category_id TEXT NOT NULL REFERENCES categories(category_id),
  category_snapshot TEXT NOT NULL,
  subcategory_snapshot TEXT,
  counterparty_id TEXT REFERENCES counterparties(counterparty_id),
  note TEXT
);

INSERT INTO allocations_v2 (
  allocation_id, transaction_id, funds_effect, purpose, amount, currency,
  category_id, category_snapshot, subcategory_snapshot
)
SELECT
  a.allocation_id,
  a.transaction_id,
  a.funds_effect,
  a.purpose,
  a.amount,
  a.currency,
  CASE
    WHEN a.category IN ('food', '餐飲') AND a.subcategory IN ('meal', '午餐')
      THEN 'm2:' || t.owner_id || ':expense_dining_lunch'
    ELSE 'legacy:' || t.owner_id || ':' || lower(hex(a.category || char(0) || coalesce(a.subcategory, '')))
  END,
  a.category,
  a.subcategory
FROM allocations a
JOIN transactions t ON t.transaction_id = a.transaction_id;

DROP TABLE allocations;
DROP TABLE transactions;
ALTER TABLE transactions_v2 RENAME TO transactions;
ALTER TABLE allocations_v2 RENAME TO allocations;

CREATE TABLE transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
  tag_id TEXT NOT NULL REFERENCES tags(tag_id),
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE transaction_links (
  link_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  from_transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
  to_transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
  link_type TEXT NOT NULL CHECK (link_type = 'refund_of'),
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  created_at TEXT NOT NULL,
  UNIQUE (from_transaction_id, to_transaction_id, link_type),
  CHECK (from_transaction_id <> to_transaction_id)
);

CREATE TABLE audit_events (
  audit_event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL REFERENCES input_events(event_id),
  action TEXT NOT NULL CHECK (
    action IN (
      'transaction_created', 'transaction_updated', 'transaction_deleted',
      'transaction_linked', 'transaction_unlinked'
    )
  ),
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

UPDATE drafts SET status = 'archived' WHERE status NOT IN ('confirmed', 'cancelled');

CREATE INDEX transactions_owner_date_status_idx
  ON transactions(owner_id, occurred_date DESC, status);
CREATE INDEX allocations_transaction_idx ON allocations(transaction_id);
CREATE INDEX allocations_category_idx ON allocations(category_id);
CREATE INDEX transaction_links_target_idx ON transaction_links(to_transaction_id, link_type);
CREATE INDEX audit_events_transaction_created_idx ON audit_events(transaction_id, created_at);
