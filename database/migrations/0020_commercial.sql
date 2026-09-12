BEGIN;
SET LOCAL search_path TO agent_market, public;

-- This ledger records obligations and verified observations, never assumed cash.
CREATE TABLE commercial_orders (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE commercial_commands (
  task_id uuid NOT NULL REFERENCES commercial_orders(task_id) ON DELETE RESTRICT,
  actor_wallet text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, actor_wallet, idempotency_key)
);
CREATE TABLE commercial_receipts (
  receipt_id text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES commercial_orders(task_id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A journal row is a balanced pair of postings in one asset, atomic by construction.
CREATE TABLE commercial_journal (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES commercial_orders(task_id) ON DELETE RESTRICT,
  event_key text NOT NULL,
  asset_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('node','platform','refund','yield','penalty','payment','observed_yield','observed_penalty')),
  debit_account text NOT NULL,
  credit_account text NOT NULL,
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (debit_account <> credit_account),
  UNIQUE (task_id,event_key)
);
CREATE FUNCTION commercial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'COMMERCIAL_IMMUTABLE'; END;
$$;
CREATE TRIGGER commercial_journal_immutable BEFORE UPDATE OR DELETE ON commercial_journal
  FOR EACH ROW EXECUTE FUNCTION commercial_immutable();
CREATE TRIGGER commercial_receipt_immutable BEFORE UPDATE OR DELETE ON commercial_receipts
  FOR EACH ROW EXECUTE FUNCTION commercial_immutable();
CREATE TRIGGER commercial_command_immutable BEFORE UPDATE OR DELETE ON commercial_commands
  FOR EACH ROW EXECUTE FUNCTION commercial_immutable();
CREATE VIEW commercial_postings AS
  SELECT id, task_id, asset_id, kind, debit_account AS account, amount_atomic AS debit_atomic, 0::numeric AS credit_atomic FROM commercial_journal
  UNION ALL
  SELECT id, task_id, asset_id, kind, credit_account AS account, 0::numeric, amount_atomic FROM commercial_journal;
CREATE VIEW commercial_balances AS
  SELECT task_id, asset_id, account, sum(debit_atomic)::text AS debit_atomic,
    sum(credit_atomic)::text AS credit_atomic, (sum(credit_atomic)-sum(debit_atomic))::text AS balance_atomic
  FROM commercial_postings GROUP BY task_id,asset_id,account;
COMMIT;
