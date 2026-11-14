-- Phase 4 capacity: indexed recency for ticker / history queries.
-- Additive and prod-safe: plain CREATE INDEX IF NOT EXISTS, no table rewrite.
CREATE INDEX IF NOT EXISTS idx_spins_created_at ON spins (created_at);
