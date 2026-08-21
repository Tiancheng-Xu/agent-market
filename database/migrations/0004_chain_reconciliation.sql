BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_market;
SET LOCAL search_path TO agent_market, public;

ALTER TABLE chain_transactions
  ADD COLUMN IF NOT EXISTS call_data text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS block_hash text,
  ADD COLUMN IF NOT EXISTS event_name text,
  ADD COLUMN IF NOT EXISTS event_request_ref bytea,
  ADD COLUMN IF NOT EXISTS resource_id uuid REFERENCES tasks(id),
  ADD COLUMN IF NOT EXISTS expected_budget_atomic numeric(78, 0),
  ADD COLUMN IF NOT EXISTS expected_bond_atomic numeric(78, 0),
  ADD COLUMN IF NOT EXISTS expected_agent_wins boolean,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

ALTER TABLE chain_transactions
  DROP CONSTRAINT IF EXISTS chain_transactions_request_ref_key;

CREATE INDEX IF NOT EXISTS idx_chain_transactions_request_ref
  ON chain_transactions (request_ref, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transactions_call_data_format'
      AND conrelid = 'agent_market.chain_transactions'::regclass
  ) THEN
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_call_data_format
      CHECK (call_data IS NULL OR call_data ~ '^0x([0-9a-f]{2})+$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transactions_event_request_ref_matches_intent'
      AND conrelid = 'agent_market.chain_transactions'::regclass
  ) THEN
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_event_request_ref_matches_intent
      CHECK (event_request_ref IS NULL OR event_request_ref = request_ref);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transactions_exact_bond_expectation'
      AND conrelid = 'agent_market.chain_transactions'::regclass
  ) THEN
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_exact_bond_expectation
      CHECK (
        (expected_budget_atomic IS NULL AND expected_bond_atomic IS NULL)
        OR (
          expected_budget_atomic > 0
          AND expected_bond_atomic = trunc(expected_budget_atomic * 6 / 100)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transactions_block_hash_format'
      AND conrelid = 'agent_market.chain_transactions'::regclass
  ) THEN
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_block_hash_format
      CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transactions_event_request_ref_length'
      AND conrelid = 'agent_market.chain_transactions'::regclass
  ) THEN
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_event_request_ref_length
      CHECK (event_request_ref IS NULL OR octet_length(event_request_ref) = 32);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transactions_confirmed_observation'
      AND conrelid = 'agent_market.chain_transactions'::regclass
  ) THEN
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_confirmed_observation
      CHECK (
        status != 'confirmed'
        OR (
          block_hash IS NOT NULL
          AND (
            method NOT IN ('createTask', 'assignAgent', 'acceptTask', 'submitWork',
              'acceptWork', 'timeoutTask', 'openDispute')
            OR event_request_ref = request_ref
          )
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chain_transactions_hash_status
  ON chain_transactions (transaction_hash, status)
  WHERE transaction_hash IS NOT NULL;

COMMIT;
