-- Section D (money operations): workflow columns on transactions.
-- approved_by/approved_at: first approver in the dual-approval flow.
-- paid_at/payout_ref: the mark-paid step for withdrawals.
-- review_note: admin reject reasons / notes. hold_reason: auto-hold
-- or manual hold that blocks approval until released.
-- Hand-applied to the live DB on 2026-10-29 alongside the D1 deploy.
ALTER TABLE transactions ADD COLUMN approved_by integer;
ALTER TABLE transactions ADD COLUMN approved_at integer;
ALTER TABLE transactions ADD COLUMN payout_ref text;
ALTER TABLE transactions ADD COLUMN paid_at integer;
ALTER TABLE transactions ADD COLUMN review_note text;
ALTER TABLE transactions ADD COLUMN hold_reason text;
