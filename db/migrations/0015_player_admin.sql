-- Section C (player management): internal notes per player and a
-- lightweight tag list on the user row (JSON array of short labels).
-- Hand-applied to the live DB on 2026-10-29 alongside the C1 deploy.
CREATE TABLE IF NOT EXISTS player_notes (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer NOT NULL,
  admin_id integer,
  note text NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_notes_user ON player_notes (user_id, created_at);
ALTER TABLE users ADD COLUMN tags text;
