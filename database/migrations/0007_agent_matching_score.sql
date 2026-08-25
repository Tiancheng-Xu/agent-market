BEGIN;

ALTER TABLE agent_market.tasks
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE agent_market.agents
  ADD COLUMN IF NOT EXISTS categories TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS model_tag TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_market.agents
  ALTER COLUMN quality_score SET DEFAULT 0.30;

CREATE TABLE IF NOT EXISTS agent_market.agent_score_events (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agent_market.agents(id) ON DELETE CASCADE,
  task_id UUID REFERENCES agent_market.tasks(id) ON DELETE SET NULL,
  node_id TEXT NOT NULL,
  run_id UUID,
  score NUMERIC(6,5) NOT NULL CHECK (score >= 0 AND score <= 1),
  reason_code TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, task_id, node_id, run_id, reason_code)
);

CREATE INDEX IF NOT EXISTS idx_agent_score_events_window
  ON agent_market.agent_score_events (agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_categories_gin
  ON agent_market.agents USING GIN (categories);
CREATE INDEX IF NOT EXISTS idx_agents_tags_gin
  ON agent_market.agents USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_tasks_tags_gin
  ON agent_market.tasks USING GIN (tags);

COMMIT;
