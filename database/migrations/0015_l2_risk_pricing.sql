BEGIN;

SET LOCAL search_path TO agent_market, public;

CREATE TABLE IF NOT EXISTS risk_quotes (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  quote_version integer NOT NULL CHECK (quote_version > 0),
  phase text NOT NULL CHECK (phase IN ('preliminary', 'final')),
  task_fingerprint text NOT NULL CHECK (task_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  dag_revision integer NOT NULL CHECK (dag_revision >= 0),
  policy_version text NOT NULL,
  basis_fingerprint text NOT NULL CHECK (basis_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  quote_payload jsonb NOT NULL,
  manual_review_required boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  superseded_by uuid,
  superseded_at timestamptz,
  manual_approved_at timestamptz,
  manual_approved_by text,
  created_at timestamptz NOT NULL,
  UNIQUE (task_id, quote_version),
  CONSTRAINT fk_risk_quotes_superseded_by
    FOREIGN KEY (superseded_by) REFERENCES risk_quotes(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE,
  CHECK ((status = 'active' AND superseded_by IS NULL AND superseded_at IS NULL)
    OR (status = 'superseded' AND superseded_by IS NOT NULL AND superseded_at IS NOT NULL)),
  CHECK ((manual_approved_at IS NULL) = (manual_approved_by IS NULL)),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_quotes_one_active_per_task
  ON risk_quotes (task_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS risk_quote_agent_allocations (
  quote_id uuid NOT NULL REFERENCES risk_quotes(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  agent_wallet text NOT NULL,
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic >= 0),
  PRIMARY KEY (quote_id, agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_quote_agent_wallet
  ON risk_quote_agent_allocations (quote_id, lower(agent_wallet));

CREATE TABLE IF NOT EXISTS risk_quote_confirmations (
  quote_id uuid NOT NULL REFERENCES risk_quotes(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('publisher', 'agent')),
  actor_key text NOT NULL,
  actor_wallet text NOT NULL,
  agent_id text,
  task_fingerprint text NOT NULL CHECK (task_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, actor_type, actor_key),
  CHECK ((actor_type = 'publisher' AND agent_id IS NULL)
    OR (actor_type = 'agent' AND agent_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_quote_confirmation_wallet
  ON risk_quote_confirmations (quote_id, actor_type, lower(actor_wallet));

CREATE OR REPLACE FUNCTION guard_risk_quote_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.task_id, OLD.quote_version, OLD.phase, OLD.task_fingerprint,
    OLD.dag_revision, OLD.policy_version, OLD.basis_fingerprint,
    OLD.quote_payload, OLD.manual_review_required, OLD.expires_at, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.task_id, NEW.quote_version, NEW.phase, NEW.task_fingerprint,
    NEW.dag_revision, NEW.policy_version, NEW.basis_fingerprint,
    NEW.quote_payload, NEW.manual_review_required, NEW.expires_at, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'RISK_QUOTE_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_risk_quote_immutable ON risk_quotes;
CREATE TRIGGER trg_risk_quote_immutable
  BEFORE UPDATE ON risk_quotes
  FOR EACH ROW EXECUTE FUNCTION guard_risk_quote_immutable();

COMMIT;
