BEGIN;
ALTER TABLE agent_market.commercial_journal DROP CONSTRAINT commercial_journal_kind_check;
ALTER TABLE agent_market.commercial_journal ADD CONSTRAINT commercial_journal_kind_check CHECK (kind IN (
  'node','platform','refund','yield','penalty','payment','observed_yield','observed_penalty','deposit_return'
));
-- Existing unbound JSON snapshots deliberately remain unmodified. Writes fail with
-- COMMERCIAL_REBIND_REQUIRED; do not retroactively invent bilateral quote consent.
COMMIT;
