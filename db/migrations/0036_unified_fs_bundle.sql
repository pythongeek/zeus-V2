-- U4 Option B: a converted (unified) free-spin round pins the cascade
-- bundle its spins resolve through, so the gentler unified math never
-- leaks into the standalone cascade mode and vice versa. Banked rounds
-- carry the pin with them.
ALTER TABLE game_sessions ADD COLUMN free_spins_bundle TEXT;
--> statement-breakpoint
ALTER TABLE banked_free_spins ADD COLUMN bundle TEXT;
