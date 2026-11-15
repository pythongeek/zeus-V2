-- 0035_security_hardening.sql
-- Phase 6 remediation (2026-11-16):
--   P6-03: persist the last accepted TOTP time-step so a code is single-use.
--   Additive, nullable: existing admins simply have no consumed step yet.
ALTER TABLE users ADD COLUMN last_totp_counter INTEGER;
