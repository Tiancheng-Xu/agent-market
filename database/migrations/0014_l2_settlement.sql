BEGIN;

SET LOCAL search_path TO agent_market, public;

CREATE TABLE IF NOT EXISTS order_settlement_observations (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL,
  request_id uuid NOT NULL,
  transaction_hash text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('verifying', 'confirmed', 'failed', 'reorged')),
  event_name text,
  block_number bigint,
  confirmations integer NOT NULL CHECK (confirmations >= 0),
  projection_action text,
  projection_reason_code text,
  canonical_block_hash text,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, intent_id),
  UNIQUE (request_id),
  UNIQUE (transaction_hash),
  CHECK (verification_status <> 'confirmed' OR (event_name IS NOT NULL AND block_number IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_order_settlement_manual_review
  ON order_settlement_observations (checked_at DESC)
  WHERE projection_action = 'mark_manual_review';

COMMIT;
