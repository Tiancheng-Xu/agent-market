BEGIN;

SET LOCAL search_path TO agent_market, public;

CREATE TABLE IF NOT EXISTS queen_workflows (
  task_id uuid PRIMARY KEY,
  record_version integer NOT NULL CHECK (record_version > 0),
  graph_revision integer NOT NULL CHECK (graph_revision > 0),
  run_id uuid,
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((snapshot ->> 'taskId')::uuid = task_id),
  CHECK ((snapshot ->> 'recordVersion')::integer = record_version),
  CHECK ((snapshot #>> '{graph,graphRevision}')::integer = graph_revision)
);

CREATE TABLE IF NOT EXISTS queen_workflow_events (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES queen_workflows(task_id) ON DELETE CASCADE,
  record_version integer NOT NULL CHECK (record_version > 0),
  graph_revision integer NOT NULL CHECK (graph_revision > 0),
  operation_name text NOT NULL,
  actor_id text,
  reason_code text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  UNIQUE (task_id, record_version)
);

CREATE INDEX IF NOT EXISTS idx_queen_workflows_run
  ON queen_workflows (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_queen_workflow_events_task
  ON queen_workflow_events (task_id, record_version DESC);

COMMIT;
