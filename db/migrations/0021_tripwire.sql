-- Step 15 (re-prioritized first, Cascade Decision Playbook §4.1):
-- two-layer RTP-drift tripwire state. One row per mode carries the
-- incremental Layer-2 state (EWMA + CUSUM) and the last processed
-- spin; Layer 1 is computed from the spins window on each run.
-- tripwire_events is the append-only record of breaches, drift
-- alarms and bundle-hash audit failures.
CREATE TABLE IF NOT EXISTS tripwire_state (
  mode_id TEXT PRIMARY KEY,
  last_spin_id INTEGER NOT NULL DEFAULT 0,
  ewma REAL,
  cusum_pos REAL NOT NULL DEFAULT 0,
  cusum_neg REAL NOT NULL DEFAULT 0,
  spins_seen INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tripwire_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id TEXT NOT NULL,
  layer INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  spin_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tripwire_events_mode ON tripwire_events (mode_id, id);
