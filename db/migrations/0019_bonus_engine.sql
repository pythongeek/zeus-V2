-- Step 4 (BD production plan): bonus engine foundation.
-- One bonus_ledger reused by every bonus kind (deposit boost now;
-- cashback, reload, red envelope, referral, VIP wheel later), a
-- bonus bucket on balances, and a bucket column on ledger_entries
-- so reconciliation can verify the bonus chain separately from the
-- available chain. Existing legs default to the 'available' bucket.
CREATE TABLE IF NOT EXISTS bonus_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  remaining TEXT NOT NULL,
  wagering_multiplier INTEGER NOT NULL DEFAULT 1,
  wagered TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'active',
  ref_tx_id INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_bonus_ledger_user ON bonus_ledger (user_id, currency, status);
ALTER TABLE balances ADD COLUMN bonus TEXT NOT NULL DEFAULT '0';
ALTER TABLE ledger_entries ADD COLUMN bucket TEXT NOT NULL DEFAULT 'available';
