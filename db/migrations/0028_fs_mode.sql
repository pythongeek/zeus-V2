-- Step 5: free spins remember which mode awarded them; a session's
-- pending free spins always play out in that mode.
ALTER TABLE game_sessions ADD COLUMN free_spins_mode TEXT NOT NULL DEFAULT 'classic';
