-- Explicit setup after the core schema and queen-runtime-scopes.sql.
-- No runtime startup migration; provision application/worker grants separately.
BEGIN;
CREATE TABLE IF NOT EXISTS agent_market.queen_planning_requests (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agent_market.tasks(id) ON DELETE RESTRICT,
  task_version integer NOT NULL CHECK (task_version > 0),
  publisher_wallet text NOT NULL,
  payload jsonb NOT NULL,
  event jsonb NOT NULL,
  allowed_action text NOT NULL CHECK (allowed_action = 'plan'),
  status text NOT NULL CHECK (status IN ('requested', 'revoked')),
  expires_at timestamptz NOT NULL,
  approval_id uuid UNIQUE,
  approval_decision boolean,
  approval_payload jsonb,
  approval_event jsonb,
  approval_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, task_version),
  CHECK ((event ->> 'payloadRef')::uuid = id),
  CHECK ((event ->> 'taskId')::uuid = task_id),
  CHECK ((approval_id IS NULL AND approval_decision IS NULL AND approval_payload IS NULL
      AND approval_event IS NULL AND approval_expires_at IS NULL)
    OR (approval_id IS NOT NULL AND approval_decision IS NOT NULL AND approval_payload IS NOT NULL
      AND approval_event IS NOT NULL AND approval_expires_at IS NOT NULL)),
  CHECK (approval_event IS NULL OR (approval_event ->> 'payloadRef')::uuid = approval_id),
  CHECK (approval_event IS NULL OR (approval_event ->> 'taskId')::uuid = task_id)
);
ALTER TABLE agent_market.queen_planning_requests ADD COLUMN IF NOT EXISTS approval_id uuid UNIQUE;
ALTER TABLE agent_market.queen_planning_requests ADD COLUMN IF NOT EXISTS approval_decision boolean;
ALTER TABLE agent_market.queen_planning_requests ADD COLUMN IF NOT EXISTS approval_payload jsonb;
ALTER TABLE agent_market.queen_planning_requests ADD COLUMN IF NOT EXISTS approval_event jsonb;
ALTER TABLE agent_market.queen_planning_requests ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_queen_planning_requests_approval_id
  ON agent_market.queen_planning_requests (approval_id) WHERE approval_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queen_planning_event_payload_ref_matches'
      AND conrelid = 'agent_market.queen_planning_requests'::regclass) THEN
    ALTER TABLE agent_market.queen_planning_requests
      ADD CONSTRAINT queen_planning_event_payload_ref_matches
      CHECK ((event ->> 'payloadRef')::uuid = id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queen_planning_event_task_matches'
      AND conrelid = 'agent_market.queen_planning_requests'::regclass) THEN
    ALTER TABLE agent_market.queen_planning_requests
      ADD CONSTRAINT queen_planning_event_task_matches
      CHECK ((event ->> 'taskId')::uuid = task_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queen_planning_approval_all_or_none'
      AND conrelid = 'agent_market.queen_planning_requests'::regclass) THEN
    ALTER TABLE agent_market.queen_planning_requests
      ADD CONSTRAINT queen_planning_approval_all_or_none CHECK (
        (approval_id IS NULL AND approval_decision IS NULL AND approval_payload IS NULL
          AND approval_event IS NULL AND approval_expires_at IS NULL)
        OR (approval_id IS NOT NULL AND approval_decision IS NOT NULL AND approval_payload IS NOT NULL
          AND approval_event IS NOT NULL AND approval_expires_at IS NOT NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queen_planning_approval_payload_ref_matches'
      AND conrelid = 'agent_market.queen_planning_requests'::regclass) THEN
    ALTER TABLE agent_market.queen_planning_requests
      ADD CONSTRAINT queen_planning_approval_payload_ref_matches
      CHECK (approval_event IS NULL OR (approval_event ->> 'payloadRef')::uuid = approval_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queen_planning_approval_task_matches'
      AND conrelid = 'agent_market.queen_planning_requests'::regclass) THEN
    ALTER TABLE agent_market.queen_planning_requests
      ADD CONSTRAINT queen_planning_approval_task_matches
      CHECK (approval_event IS NULL OR (approval_event ->> 'taskId')::uuid = task_id) NOT VALID;
  END IF;
END $$;
ALTER TABLE agent_market.queen_planning_requests VALIDATE CONSTRAINT queen_planning_event_payload_ref_matches;
ALTER TABLE agent_market.queen_planning_requests VALIDATE CONSTRAINT queen_planning_event_task_matches;
ALTER TABLE agent_market.queen_planning_requests VALIDATE CONSTRAINT queen_planning_approval_all_or_none;
ALTER TABLE agent_market.queen_planning_requests VALIDATE CONSTRAINT queen_planning_approval_payload_ref_matches;
ALTER TABLE agent_market.queen_planning_requests VALIDATE CONSTRAINT queen_planning_approval_task_matches;
REVOKE ALL ON agent_market.queen_planning_requests FROM PUBLIC;
COMMIT;
