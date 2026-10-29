-- Step 15 fix (found by the Phase 0 MC harness): the tripwire must
-- observe the quantity the RTP claim describes — total return per
-- PAID spin including its free-spin chain. Spin rows alone understate
-- it (free-spin wins live on their own rows). Evaluation now folds
-- rows into processes; completed processes land in
-- tripwire_processes, and the open process rides in tripwire_state.
ALTER TABLE tripwire_state ADD COLUMN pending_session INTEGER;
ALTER TABLE tripwire_state ADD COLUMN pending_bet REAL;
ALTER TABLE tripwire_state ADD COLUMN pending_win REAL NOT NULL DEFAULT 0;
ALTER TABLE tripwire_state ADD COLUMN pending_spin_id INTEGER;

CREATE TABLE IF NOT EXISTS tripwire_processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id TEXT NOT NULL,
  spin_id INTEGER NOT NULL,
  x REAL NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tripwire_processes_mode ON tripwire_processes (mode_id, id);
