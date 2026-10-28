-- Section F1 (jackpot centre): pool balance snapshots for the
-- history chart. Written every 5 minutes by the health monitor
-- (scripts/monitor.sh), pruned to 30 days there. No spin-path cost.
-- Hand-applied to the live DB on 2026-10-29 alongside the F1 deploy.
CREATE TABLE IF NOT EXISTS jackpot_pool_snapshots (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  tier text NOT NULL,
  amount text NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jackpot_snapshots_tier_ts ON jackpot_pool_snapshots (tier, created_at);
