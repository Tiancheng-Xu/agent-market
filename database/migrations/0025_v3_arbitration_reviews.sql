BEGIN;

CREATE TABLE agent_market.chain_arbitration_reviews (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES agent_market.tasks(id),
  resource_revision integer NOT NULL CHECK (resource_revision > 0),
  reviewer_wallet text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('agents_win', 'publisher_wins')),
  args jsonb NOT NULL CHECK (
    jsonb_typeof(args) = 'object'
    AND args ? 'agentsWin'
    AND args - 'agentsWin' = '{}'::jsonb
    AND jsonb_typeof(args->'agentsWin') = 'boolean'
  ),
  review_hash text NOT NULL UNIQUE CHECK (review_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  superseded_at timestamptz,
  CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);

CREATE UNIQUE INDEX chain_arbitration_reviews_current_resource
  ON agent_market.chain_arbitration_reviews (resource_id)
  WHERE superseded_at IS NULL;

CREATE INDEX chain_arbitration_reviews_current_lookup
  ON agent_market.chain_arbitration_reviews (resource_id, resource_revision, expires_at)
  WHERE superseded_at IS NULL;

ALTER TABLE agent_market.chain_transactions
  ADD COLUMN expected_resource_revision integer,
  ADD COLUMN expected_review_id uuid,
  ADD COLUMN expected_review_hash text,
  ADD COLUMN expected_review_expires_at timestamptz,
  ADD CONSTRAINT chain_transactions_review_expectation_complete CHECK (
    (
      expected_resource_revision IS NULL
      AND expected_review_id IS NULL
      AND expected_review_hash IS NULL
      AND expected_review_expires_at IS NULL
    ) OR (
      expected_resource_revision > 0
      AND expected_review_id IS NOT NULL
      AND expected_review_hash ~ '^sha256:[0-9a-f]{64}$'
      AND expected_review_expires_at IS NOT NULL
    )
  );

COMMIT;
