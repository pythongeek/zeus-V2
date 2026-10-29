-- Phase 0 (Cascade Decision Playbook §5.2/§5.3): mode registry + wager
-- telemetry binding. Every spin records which game mode and which exact
-- math bundle (by SHA-256) resolved it, so fairness replay can fetch the
-- bundle by hash and the RTP tripwire can audit bundle hashes per mode.
ALTER TABLE spins ADD COLUMN mode_id TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE spins ADD COLUMN bundle_id TEXT;
ALTER TABLE spins ADD COLUMN bundle_sha256 TEXT;

CREATE TABLE IF NOT EXISTS math_bundles (
  bundle_id TEXT PRIMARY KEY,
  mode_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  bundle TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  math_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  cert TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  activated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_spins_mode ON spins (mode_id, id);
CREATE INDEX IF NOT EXISTS idx_bundles_mode_status ON math_bundles (mode_id, status);
