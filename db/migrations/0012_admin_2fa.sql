-- AP1: admin two-factor authentication.
-- users gain an encrypted TOTP secret + enabled flag; recovery-code
-- hashes live in their own table. Hand-applied to the live DB on
-- 2026-10-29 (bootstrap only auto-applies migrations to empty DBs).
ALTER TABLE users ADD COLUMN totp_secret text;
ALTER TABLE users ADD COLUMN totp_enabled integer DEFAULT 0 NOT NULL;
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id integer PRIMARY KEY AUTOINCREMENT,
  user_id integer NOT NULL,
  code_hash text NOT NULL,
  used_at integer,
  created_at integer DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
