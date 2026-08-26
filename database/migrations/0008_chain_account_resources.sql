BEGIN;

CREATE TABLE IF NOT EXISTS agent_market.chain_account_resources (
  id uuid PRIMARY KEY,
  wallet_address text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_market.chain_transactions
  DROP CONSTRAINT IF EXISTS chain_transactions_resource_id_fkey;

ALTER TABLE agent_market.chain_transactions
  ADD COLUMN IF NOT EXISTS resource_kind text NOT NULL DEFAULT 'task'
    CHECK (resource_kind IN ('task', 'account'));

COMMIT;
