BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_market;
SET LOCAL search_path TO agent_market, public;

CREATE TABLE IF NOT EXISTS recovery_replays (
  original_event_id uuid PRIMARY KEY,
  original_request_id uuid NOT NULL,
  replay_id uuid NOT NULL,
  operator_idempotency_key text NOT NULL,
  publisher_idempotency_key text NOT NULL UNIQUE,
  original_body_hash text NOT NULL CHECK (original_body_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT recovery_replays_identity_unique
    UNIQUE (original_event_id, original_request_id, publisher_idempotency_key, original_body_hash),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status <> 'publishing' OR lease_until IS NOT NULL),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS recovery_replay_outbox (
  original_event_id uuid PRIMARY KEY,
  original_request_id uuid NOT NULL,
  event_body jsonb NOT NULL,
  publisher_idempotency_key text NOT NULL UNIQUE,
  original_body_hash text NOT NULL CHECK (original_body_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT recovery_replay_outbox_parent_identity_fk
    FOREIGN KEY (
      original_event_id,
      original_request_id,
      publisher_idempotency_key,
      original_body_hash
    )
    REFERENCES recovery_replays (
      original_event_id,
      original_request_id,
      publisher_idempotency_key,
      original_body_hash
    )
    ON DELETE RESTRICT,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status <> 'publishing' OR lease_until IS NOT NULL),
  CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CHECK (jsonb_typeof(event_body) = 'object'),
  CHECK (event_body ? 'eventId' AND jsonb_typeof(event_body->'eventId') = 'string'
    AND event_body->>'eventId' = original_event_id::text),
  CHECK (event_body ? 'requestId' AND jsonb_typeof(event_body->'requestId') = 'string'
    AND event_body->>'requestId' = original_request_id::text)
);

CREATE INDEX IF NOT EXISTS idx_recovery_replays_status_retry
  ON recovery_replays (status, next_attempt_at, lease_until);

CREATE INDEX IF NOT EXISTS idx_recovery_outbox_ready
  ON recovery_replay_outbox (next_attempt_at, lease_until, created_at)
  WHERE status IN ('pending', 'publishing', 'failed');

COMMIT;
