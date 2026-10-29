-- Step 7: near-miss telemetry. The flag records a FACT about the
-- settled outcome (classic: exactly 2 scatters; cascade: final
-- grid's largest symbol count exactly 7, one short of a cluster).
-- The tease itself is presentation-only and kill-flagged.
ALTER TABLE spins ADD COLUMN near_miss INTEGER NOT NULL DEFAULT 0;
