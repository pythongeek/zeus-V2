-- AP3: session epoch for force sign-out (revokes all existing
-- sessions for an account). Hand-applied to the live DB on
-- 2026-10-29 alongside the code deploy.
ALTER TABLE users ADD COLUMN session_epoch integer DEFAULT 0 NOT NULL;
