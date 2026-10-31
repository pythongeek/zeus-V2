-- FS banking (2026-10-31): unplayed free spins are banked when a
-- session ends or is replaced, and restored into the player's next
-- session with their bet/currency/mode/ladder-rung intact. Before
-- this, startSession silently completed the previous session and
-- any free spins on it were stranded forever (a completed session
-- holding 3 unplayed spins exists in production data).
CREATE TABLE IF NOT EXISTS banked_free_spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  spins INTEGER NOT NULL,
  bet_amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'classic',
  ladder_rung INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_banked_fs_user ON banked_free_spins (user_id, id);
