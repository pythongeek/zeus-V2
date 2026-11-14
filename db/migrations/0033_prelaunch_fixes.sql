-- 0033_prelaunch_fixes.sql
-- Pre-launch remediation (2026-11-15):
--   * A5: deposit references must be globally unique (one on-chain payment
--     cannot be credited twice). Partial index limits this to deposits with
--     a reference; withdrawals/legacy rows with NULL are unaffected.
--   * GE-01/GE-05: per-spin fairness stamping for the v2 hash and for
--     replayable Thunder Strike verification, without invalidating the
--     existing v1 spins (hash_version defaults to 1 = legacy).
--   * Branding data fix: the Binance Pay display name was the old
--     "CryptoFlip Official"; align it with the MegaSlot/Zeus brand.

CREATE UNIQUE INDEX IF NOT EXISTS uk_tx_hash_deposit
  ON transactions(tx_hash)
  WHERE type = 'deposit' AND tx_hash IS NOT NULL;

ALTER TABLE spins ADD COLUMN client_seed TEXT;
ALTER TABLE spins ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE spins ADD COLUMN base_symbols TEXT;
ALTER TABLE spins ADD COLUMN thunder TEXT;

UPDATE settings
   SET value = '"MegaSlot"'
 WHERE key = 'binance_pay_name'
   AND value LIKE '%CryptoFlip%';
