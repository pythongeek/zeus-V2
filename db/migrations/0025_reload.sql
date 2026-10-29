-- Step 12: reload-bonus opt-ins. A player arms an offer BEFORE
-- depositing; when that deposit is approved, the bonus attaches.
-- (The Binance rail is asynchronous — request now, admin approval
-- later — so the plan's 60-second activation card becomes an
-- armed opt-in with a multi-day validity window instead.)
CREATE TABLE IF NOT EXISTS reload_optins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  offer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'armed',
  deposit_tx_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reload_optins_user ON reload_optins (user_id, status);
