BEGIN;

SET LOCAL search_path TO agent_market, public;

CREATE TABLE IF NOT EXISTS order_reviews (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  reviewer_wallet text NOT NULL,
  agent_owner_wallet text NOT NULL,
  quality_score numeric(6,5) NOT NULL CHECK (quality_score BETWEEN 0 AND 1),
  timeliness_score numeric(6,5) NOT NULL CHECK (timeliness_score BETWEEN 0 AND 1),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'refunded', 'disputed')),
  reason_codes text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lower(reviewer_wallet) <> lower(agent_owner_wallet))
);

CREATE TABLE IF NOT EXISTS reputation_wallet_links (
  owner_wallet text NOT NULL,
  linked_wallet text NOT NULL,
  reason_code text NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (owner_wallet, linked_wallet),
  CHECK (lower(owner_wallet) <> lower(linked_wallet))
);

CREATE TABLE IF NOT EXISTS agent_reputation_snapshots (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  score numeric(7,6) NOT NULL CHECK (score BETWEEN 0 AND 1),
  sample_count integer NOT NULL CHECK (sample_count >= 0),
  effective_sample_weight numeric(12,8) NOT NULL CHECK (effective_sample_weight >= 0),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  acceptance_rate numeric(7,6) NOT NULL CHECK (acceptance_rate BETWEEN 0 AND 1),
  refund_rate numeric(7,6) NOT NULL CHECK (refund_rate BETWEEN 0 AND 1),
  dispute_rate numeric(7,6) NOT NULL CHECK (dispute_rate BETWEEN 0 AND 1),
  formula_version text NOT NULL CHECK (formula_version = 'reputation-v1'),
  calculated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS reputation_anomalies (
  id uuid PRIMARY KEY,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  reason_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'dismissed', 'confirmed')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_order_reviews_agent_window
  ON order_reviews (agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_reputation_anomalies_open
  ON reputation_anomalies (created_at DESC) WHERE status = 'open';

COMMIT;
