-- Section E (RTP Lab): published math versions. Append-only: every
-- publish (including rollbacks, which re-publish an older bundle)
-- adds one row with the certified breakdown that justified it.
-- Hand-applied to the live DB on 2026-10-29 alongside the E2 deploy.
CREATE TABLE IF NOT EXISTS math_versions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  bundle text NOT NULL,
  total_rtp real NOT NULL,
  breakdown text,
  note text,
  published_by integer,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_math_versions_created ON math_versions (created_at);
