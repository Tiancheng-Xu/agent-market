-- Explicit, private runtime setup. Never run automatically on runtime startup.
-- Separate least-privilege database roles must be provisioned by the operator.
BEGIN;
CREATE SCHEMA IF NOT EXISTS queen_runtime_public;
CREATE SCHEMA IF NOT EXISTS queen_runtime_owner;
CREATE TABLE IF NOT EXISTS queen_runtime_public.queen_workflows (
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
CREATE TABLE IF NOT EXISTS queen_runtime_owner.queen_workflows
  (LIKE queen_runtime_public.queen_workflows INCLUDING ALL);
CREATE TABLE IF NOT EXISTS queen_runtime_public.queen_operations (
  operation_key text PRIMARY KEY CHECK (operation_key ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  task_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  graph_revision integer NOT NULL CHECK (graph_revision > 0),
  owner_token uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('executing', 'committed', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS queen_runtime_owner.queen_operations
  (LIKE queen_runtime_public.queen_operations INCLUDING ALL);
CREATE TABLE IF NOT EXISTS queen_runtime_public.queen_outbox (
  event_id uuid PRIMARY KEY,
  operation_key text UNIQUE NOT NULL CHECK (operation_key ~ '^sha256:[0-9a-f]{64}$'),
  event jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'published')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  CHECK ((event ->> 'eventId')::uuid = event_id),
  CHECK (event ->> 'operationKey' = operation_key)
);
CREATE TABLE IF NOT EXISTS queen_runtime_owner.queen_outbox
  (LIKE queen_runtime_public.queen_outbox INCLUDING ALL);
REVOKE ALL ON SCHEMA queen_runtime_public, queen_runtime_owner FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA queen_runtime_public, queen_runtime_owner FROM PUBLIC;
COMMIT;
