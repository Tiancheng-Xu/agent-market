BEGIN;
SET LOCAL search_path TO agent_market, public;
-- Provisioned by database administrators only; no public role-grant endpoint.
CREATE TABLE governance_roles (
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  role text NOT NULL CHECK (role IN ('operator','reviewer')),
  granted_by text NOT NULL, reason text NOT NULL CHECK (length(reason)>0),
  granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  PRIMARY KEY(wallet,role)
);
CREATE TABLE governance_events (
  id uuid PRIMARY KEY, severity text NOT NULL CHECK(severity IN ('P0','P1','P2','P3')),
  reason text NOT NULL, actor_wallet text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE governance_tickets (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id),
  opened_by text NOT NULL, reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution text, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE governance_proposals (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('resume','propose_release','propose_rollback','resolve_ticket')),
  target_id uuid NOT NULL, expected_version integer NOT NULL CHECK(expected_version>0),
  proposer_wallet text NOT NULL, reason text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewer_wallet text, review_reason text, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(reviewer_wallet IS NULL OR reviewer_wallet <> proposer_wallet),
  CHECK((status='pending' AND reviewer_wallet IS NULL AND reviewed_at IS NULL)
    OR (status<>'pending' AND reviewer_wallet IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE TABLE governance_releases (
  id uuid PRIMARY KEY REFERENCES governance_proposals(id), agent_id uuid NOT NULL REFERENCES agents(id),
  snapshot jsonb NOT NULL, published_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE governance_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid NOT NULL,
  actor_wallet text NOT NULL, action text NOT NULL, result jsonb NOT NULL,
  authority jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE governance_idempotency (
  actor_wallet text NOT NULL, idempotency_key text NOT NULL, fingerprint text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_wallet,idempotency_key)
);
CREATE INDEX governance_proposals_pending ON governance_proposals(created_at) WHERE status='pending';
CREATE INDEX governance_tickets_task ON governance_tickets(task_id,created_at);
CREATE FUNCTION governance_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GOVERNANCE_AUDIT_IMMUTABLE'; END; $$;
CREATE TRIGGER governance_audit_no_change BEFORE UPDATE OR DELETE ON governance_audit
FOR EACH ROW EXECUTE FUNCTION governance_audit_immutable();
COMMIT;
