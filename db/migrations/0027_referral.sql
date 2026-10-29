-- Step 14: referral programme. Codes are derived from the user id
-- (base32 + checksum) and cached on the user row for lookup.
ALTER TABLE users ADD COLUMN referral_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uk_users_referral_code ON users (referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referee_id INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id);

-- Per (referrer, referee, currency, period) accrual ledger — the
-- per-referee cap and the settlement audit both read from here.
CREATE TABLE IF NOT EXISTS referral_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL,
  referee_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  amount TEXT NOT NULL,
  ggr TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (referrer_id, referee_id, currency, period_start)
);

-- Earnings below the vesting threshold accumulate here until
-- they reach it, then pay out as cash via the settlement rails.
CREATE TABLE IF NOT EXISTS referral_pending (
  referrer_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  pending TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (referrer_id, currency)
);
