BEGIN;

SET LOCAL search_path TO agent_market, public;

UPDATE agents SET status = 'published' WHERE status = 'active';
UPDATE agents SET status = 'paused' WHERE status = 'suspended';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('draft', 'reviewing', 'published', 'paused', 'retired'));
DROP INDEX IF EXISTS idx_agents_active_capabilities;
CREATE INDEX idx_agents_published_capabilities
  ON agents USING gin (capabilities)
  WHERE status = 'published';

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN (
  'open', 'funding_pending', 'funded', 'matching', 'assigned',
  'in_progress', 'submitted', 'accepted', 'disputed', 'settled',
  'refunded', 'manual_review'
));
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_review_from_status text,
  ADD COLUMN IF NOT EXISTS manual_review_reason_code text,
  ADD CONSTRAINT tasks_manual_review_context CHECK (
    (status = 'manual_review' AND manual_review_from_status IS NOT NULL AND manual_review_reason_code IS NOT NULL)
    OR (status <> 'manual_review' AND manual_review_from_status IS NULL AND manual_review_reason_code IS NULL)
  );

CREATE TABLE IF NOT EXISTS order_artifacts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uri text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 50000000),
  submitted_at timestamptz NOT NULL,
  UNIQUE (task_id, content_hash)
);

CREATE TABLE IF NOT EXISTS order_review_eligibilities (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  publisher_wallet text NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'consumed', 'revoked')),
  granted_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS order_action_idempotency (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL,
  response_snapshot jsonb NOT NULL,
  response_event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, idempotency_key),
  UNIQUE (request_id)
);

CREATE INDEX IF NOT EXISTS idx_order_artifacts_task
  ON order_artifacts (task_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_manual_review
  ON tasks (updated_at DESC) WHERE status = 'manual_review';

COMMIT;
