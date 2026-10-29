-- Step 17: jurisdiction + KYC columns, RG period caps with
-- cooling-off pendings, and spin idempotency storage.
ALTER TABLE users ADD COLUMN country TEXT;
ALTER TABLE users ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'none';

ALTER TABLE user_limits ADD COLUMN deposit_limit_weekly TEXT;
ALTER TABLE user_limits ADD COLUMN deposit_limit_monthly TEXT;
ALTER TABLE user_limits ADD COLUMN pending_deposit_limit_daily TEXT;
ALTER TABLE user_limits ADD COLUMN pending_deposit_limit_weekly TEXT;
ALTER TABLE user_limits ADD COLUMN pending_deposit_limit_monthly TEXT;
ALTER TABLE user_limits ADD COLUMN pending_effective_at INTEGER;

CREATE TABLE IF NOT EXISTS spin_requests (
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  spin_id INTEGER,
  response TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, request_id)
);
