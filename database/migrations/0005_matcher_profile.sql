BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_market;
SET LOCAL search_path TO agent_market, public;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS embedding vector(384);

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check CHECK (status IN (
    'open', 'funding_pending', 'funded', 'matching', 'assigned',
    'in_progress', 'submitted', 'accepted', 'disputed', 'settled',
    'refunded', 'cancelled'
  ));

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS minimum_budget_atomic numeric(78, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quality_score numeric(7, 6) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS reliability_score numeric(7, 6) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS price_score numeric(7, 6) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS freshness_score numeric(7, 6) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS completed_tasks integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agents_matcher_scores_range'
      AND conrelid = 'agent_market.agents'::regclass
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_matcher_scores_range CHECK (
      minimum_budget_atomic >= 0
      AND quality_score BETWEEN 0 AND 1
      AND reliability_score BETWEEN 0 AND 1
      AND price_score BETWEEN 0 AND 1
      AND freshness_score BETWEEN 0 AND 1
      AND completed_tasks >= 0
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agents_embedding_nonzero'
      AND conrelid = 'agent_market.agents'::regclass
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_embedding_nonzero
      CHECK (embedding IS NULL OR vector_norm(embedding) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_embedding_nonzero'
      AND conrelid = 'agent_market.tasks'::regclass
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_embedding_nonzero
      CHECK (embedding IS NULL OR vector_norm(embedding) > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agents_embedding_hnsw
  ON agents USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active' AND available = true AND embedding IS NOT NULL AND vector_norm(embedding) > 0;

CREATE INDEX IF NOT EXISTS idx_tasks_embedding_ready
  ON tasks (id)
  WHERE embedding IS NOT NULL AND status IN ('open', 'funded', 'matching');

COMMIT;
