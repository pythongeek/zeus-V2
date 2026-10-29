-- Step 5 (tuning-driven): the cascade ladder persists across a
-- free-spin round. Sessions carry the current rung; spins record
-- the rung their resolution started at (fairness replay input).
ALTER TABLE game_sessions ADD COLUMN free_spins_rung INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spins ADD COLUMN ladder_rung INTEGER;
