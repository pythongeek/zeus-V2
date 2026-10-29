-- Step 10/13/14: weekly settlement engine storage + turnover rebate.
-- promo_settlements is the idempotency ledger for every periodic
-- promo credit (cashback, rakeback, referral): one row per
-- (kind, user, currency, period) — a period can never pay twice.
CREATE TABLE IF NOT EXISTS promo_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  amount TEXT NOT NULL,
  basis TEXT,
  tx_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS promo_settlements_uniq
  ON promo_settlements (kind, user_id, currency, period_start);

-- Turnover rebate accrues per (user, currency) inside the spin
-- transaction and auto-converts to cash at the BDT threshold.
CREATE TABLE IF NOT EXISTS rebate_balances (
  user_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  pending TEXT NOT NULL DEFAULT '0',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, currency)
);
