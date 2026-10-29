-- Step 13: VIP level-up grants, lucky-wheel entitlements, and
-- free-spin tokens (wheel prizes redeemable at session start).
CREATE TABLE IF NOT EXISTS vip_level_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tier_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BDT',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, tier_id)
);

CREATE TABLE IF NOT EXISTS wheel_entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  roll_nonce TEXT NOT NULL,
  used_at INTEGER,
  prize_label TEXT,
  prize_kind TEXT,
  prize_amount TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, source, period_start)
);
CREATE INDEX IF NOT EXISTS idx_wheel_ent_user ON wheel_entitlements (user_id, used_at);

CREATE TABLE IF NOT EXISTS free_spin_tokens (
  user_id INTEGER PRIMARY KEY,
  spins INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
