BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_market;
SET LOCAL search_path TO agent_market, public;

CREATE TABLE IF NOT EXISTS wallet_challenges (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  chain_id bigint NOT NULL CHECK (chain_id = 11155111),
  nonce_hash bytea NOT NULL UNIQUE,
  domain text NOT NULL,
  uri text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at),
  UNIQUE (request_id, wallet_address, chain_id)
);

CREATE TABLE IF NOT EXISTS wallet_sessions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  chain_id bigint NOT NULL CHECK (chain_id = 11155111),
  session_hash bytea NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  recent_auth_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at),
  FOREIGN KEY (request_id, wallet_address, chain_id)
    REFERENCES wallet_challenges(request_id, wallet_address, chain_id)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
  command text NOT NULL,
  resource_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (actor_wallet, command, resource_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS chain_transactions (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE,
  request_ref bytea NOT NULL UNIQUE CHECK (octet_length(request_ref) = 32),
  chain_id bigint NOT NULL CHECK (chain_id = 11155111),
  actor_wallet text NOT NULL CHECK (actor_wallet ~ '^0x[0-9a-f]{40}$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  method text NOT NULL CHECK (method IN ('faucet','approve','createTask','assignAgent','acceptTask','submitWork','acceptWork','timeoutTask','openDispute','castVote','stake','unstake','claimYield')),
  expected_value_atomic numeric(78, 0) NOT NULL DEFAULT 0 CHECK (expected_value_atomic >= 0),
  transaction_hash text UNIQUE CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('created', 'submitted', 'verifying', 'confirmed', 'failed', 'reorged')),
  block_number bigint CHECK (block_number IS NULL OR block_number >= 0),
  confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  confirmed_at timestamptz,
  CHECK (status != 'confirmed' OR (block_number IS NOT NULL AND confirmations > 0))
);

CREATE TABLE IF NOT EXISTS consumed_events (
  event_id uuid NOT NULL,
  request_id uuid NOT NULL,
  consumer text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  result_ref text,
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS match_candidates (
  match_job_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id),
  request_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  total_score numeric(8, 6) NOT NULL CHECK (total_score BETWEEN 0 AND 1),
  component_scores jsonb NOT NULL,
  explanation jsonb NOT NULL,
  model_version text NOT NULL,
  exploration boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_job_id, agent_id),
  UNIQUE (match_job_id, rank)
);

CREATE TABLE IF NOT EXISTS match_feedback (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  match_job_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id),
  feedback_type text NOT NULL,
  selected boolean,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_versions (
  version text PRIMARY KEY,
  training_run_id uuid NOT NULL UNIQUE,
  algorithm text NOT NULL,
  feature_order jsonb NOT NULL,
  metrics jsonb NOT NULL,
  model_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('candidate', 'approved', 'rejected', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE TABLE IF NOT EXISTS dlq_replay_audits (
  replay_id uuid PRIMARY KEY,
  original_event_id uuid NOT NULL,
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  operator_wallet text NOT NULL CHECK (operator_wallet ~ '^0x[0-9a-f]{40}$'),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (original_event_id, idempotency_key)
);

ALTER TABLE agent_credentials
  ADD COLUMN IF NOT EXISTS key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  ADD COLUMN IF NOT EXISTS public_prefix text,
  ADD COLUMN IF NOT EXISTS last_four text CHECK (last_four IS NULL OR length(last_four) = 4);

CREATE INDEX IF NOT EXISTS idx_wallet_sessions_active
  ON wallet_sessions (wallet_address, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chain_transactions_reconcile
  ON chain_transactions (status, checked_at)
  WHERE status IN ('submitted', 'verifying', 'reorged');

CREATE INDEX IF NOT EXISTS idx_match_candidates_request
  ON match_candidates (request_id, rank);

CREATE INDEX IF NOT EXISTS idx_match_feedback_training
  ON match_feedback (occurred_at, feedback_type);

COMMIT;
