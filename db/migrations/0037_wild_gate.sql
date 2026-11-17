-- U5-B (2026-11-18): the gated cascade wild's round state.
-- game_sessions.free_spins_wild: the gate as rolled at the round's
-- trigger (NULL = no gated round, 0 = gate missed, 1 = wild live).
-- banked_free_spins.wild_live: the same state, carried with the bank.
-- spins.wild_live: the stamp that makes every spin replayable
-- (trigger spin: the roll; free spins: the round's state).
ALTER TABLE game_sessions ADD COLUMN free_spins_wild INTEGER;
ALTER TABLE banked_free_spins ADD COLUMN wild_live INTEGER;
ALTER TABLE spins ADD COLUMN wild_live INTEGER;
