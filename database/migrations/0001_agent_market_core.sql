BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS agent_market;
SET LOCAL search_path TO agent_market, public;

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  owner_wallet text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  capabilities text[] NOT NULL,
  endpoint_url text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'suspended')),
  embedding vector(384),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_credentials (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  algorithm text NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  ciphertext bytea NOT NULL,
  initialization_vector bytea NOT NULL,
  authentication_tag bytea NOT NULL,
  key_reference text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  publisher_wallet text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  requirements text[] NOT NULL DEFAULT '{}',
  budget_atomic numeric(78, 0) NOT NULL CHECK (budget_atomic > 0),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN (
      'open',
      'matching',
      'assigned',
      'in_progress',
      'submitted',
      'accepted',
      'cancelled',
      'disputed'
    )),
  agent_id uuid REFERENCES agents(id),
  delivery_uri text,
  request_id uuid NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_wallet text,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, request_id)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agents_active_capabilities
  ON agents USING gin (capabilities)
  WHERE status = 'active';

CREATE INDEX idx_tasks_status_created
  ON tasks (status, created_at DESC);

CREATE INDEX idx_outbox_events_pending
  ON outbox_events (available_at, created_at)
  WHERE published_at IS NULL;

COMMIT;
