-- Step 11: red envelopes — scheduled provably-fair drops with a
-- fixed pool, one claim per wallet, commit-reveal seed.
CREATE TABLE IF NOT EXISTS red_envelopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_at INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BDT',
  pool_amount TEXT NOT NULL,
  claimed_total TEXT NOT NULL DEFAULT '0',
  max_claims INTEGER NOT NULL,
  claims_count INTEGER NOT NULL DEFAULT 0,
  seed TEXT NOT NULL,
  seed_hash TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_red_envelopes_time ON red_envelopes (scheduled_at);

CREATE TABLE IF NOT EXISTS red_envelope_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  amount TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (envelope_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_red_claims_env ON red_envelope_claims (envelope_id);
