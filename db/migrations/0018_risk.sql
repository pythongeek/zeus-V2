-- Section G (risk, reconciliation & alerts): alert inbox plus
-- reconciliation run/mismatch records. Hand-applied to the live
-- DB on 2026-10-29 alongside the G deploy.
CREATE TABLE IF NOT EXISTS admin_alerts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  title text NOT NULL,
  details text,
  ref_user_id integer,
  ref_id text,
  status text NOT NULL DEFAULT 'open',
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  ack_by integer,
  ack_at integer,
  resolved_by integer,
  resolved_at integer
);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_status ON admin_alerts (status, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_alerts_dedupe ON admin_alerts (kind, ref_id, status);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  ran_by integer,
  started_at integer DEFAULT (unixepoch()) NOT NULL,
  finished_at integer,
  accounts_checked integer NOT NULL DEFAULT 0,
  mismatch_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reconciliation_mismatches (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  run_id integer,
  user_id integer NOT NULL,
  currency text NOT NULL,
  kind text NOT NULL,
  expected text,
  actual text,
  detail text,
  first_seen_at integer DEFAULT (unixepoch()) NOT NULL,
  last_seen_at integer DEFAULT (unixepoch()) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolved_by integer,
  resolved_at integer,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS idx_recon_mismatch_open ON reconciliation_mismatches (status, user_id, currency, kind);
