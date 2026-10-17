-- SPEC-SEC-01 phase 2, migration 0010: enable RLS on the financial group.
--
-- Deploy order: the application code that sets `kfin.user_id` (commit 1) and
-- the policies/functions in 0009 must already be live. Policies without an
-- enabled table are inert, so this migration is the first one that can change
-- query results.
--
-- Enabling order is accounts and their serialized children first, then the
-- reference and evidence tables the same transactions touch.
ALTER TABLE financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_amount_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
