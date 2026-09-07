BEGIN;

SET LOCAL search_path TO agent_market, public;

CREATE TABLE IF NOT EXISTS task_risk_contexts (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  context_version integer NOT NULL CHECK (context_version > 0),
  task_version integer NOT NULL CHECK (task_version > 0),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  declared_permissions text[] NOT NULL,
  duration_hours numeric(10,2) NOT NULL CHECK (duration_hours > 0 AND duration_hours <= 8760),
  dependency_classes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'superseded')),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, context_version),
  CHECK ((status = 'active' AND superseded_at IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_risk_context_active
  ON task_risk_contexts (task_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS runtime_agent_bindings (
  id uuid PRIMARY KEY,
  runtime_agent_id text NOT NULL CHECK (runtime_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  market_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  binding_version integer NOT NULL CHECK (binding_version > 0),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL,
  retired_at timestamptz,
  UNIQUE (runtime_agent_id, binding_version),
  CHECK ((status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_agent_binding_active
  ON runtime_agent_bindings (runtime_agent_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS task_graph_pricing_versions (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  graph_revision integer NOT NULL CHECK (graph_revision > 0),
  workflow_record_version integer NOT NULL CHECK (workflow_record_version > 0),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  expected_total_share_bps integer NOT NULL CHECK (expected_total_share_bps = 10000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, graph_revision)
);

CREATE TABLE IF NOT EXISTS task_graph_node_pricing_facts (
  task_id uuid NOT NULL,
  graph_revision integer NOT NULL,
  node_id text NOT NULL CHECK (node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
  runtime_agent_id text NOT NULL,
  binding_id uuid NOT NULL REFERENCES runtime_agent_bindings(id) ON DELETE RESTRICT,
  market_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  share_bps integer NOT NULL CHECK (share_bps > 0 AND share_bps <= 10000),
  node_risk_multiplier_bps integer NOT NULL
    CHECK (node_risk_multiplier_bps > 0 AND node_risk_multiplier_bps <= 100000),
  reputation_risk_multiplier_bps integer NOT NULL
    CHECK (reputation_risk_multiplier_bps > 0 AND reputation_risk_multiplier_bps <= 100000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, graph_revision, node_id),
  FOREIGN KEY (task_id, graph_revision)
    REFERENCES task_graph_pricing_versions(task_id, graph_revision) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_graph_pricing_runtime
  ON task_graph_node_pricing_facts (runtime_agent_id, task_id, graph_revision);

CREATE OR REPLACE FUNCTION enforce_task_graph_pricing_share()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_task_id uuid;
  checked_revision integer;
  expected_share integer;
  actual_share bigint;
BEGIN
  checked_task_id := COALESCE(NEW.task_id, OLD.task_id);
  checked_revision := COALESCE(NEW.graph_revision, OLD.graph_revision);
  SELECT expected_total_share_bps INTO expected_share
  FROM task_graph_pricing_versions
  WHERE task_id = checked_task_id AND graph_revision = checked_revision;
  IF expected_share IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT COALESCE(sum(share_bps), 0) INTO actual_share
  FROM task_graph_node_pricing_facts
  WHERE task_id = checked_task_id AND graph_revision = checked_revision;
  IF actual_share <> expected_share THEN
    RAISE EXCEPTION 'TASK_GRAPH_PRICING_SHARE_INVALID';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_task_graph_pricing_share ON task_graph_node_pricing_facts;
CREATE CONSTRAINT TRIGGER trg_task_graph_pricing_share
  AFTER INSERT OR UPDATE OR DELETE ON task_graph_node_pricing_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_task_graph_pricing_share();

CREATE TABLE IF NOT EXISTS reputation_v2_review_eligibilities (
  order_id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  publisher_wallet text NOT NULL CHECK (publisher_wallet ~ '^0x[0-9a-f]{40}$'),
  agent_owner_wallet text NOT NULL CHECK (agent_owner_wallet ~ '^0x[0-9a-f]{40}$'),
  order_value_atomic numeric(78,0) NOT NULL CHECK (order_value_atomic > 0),
  policy_version text NOT NULL CHECK (policy_version = 'reputation-v2'),
  status text NOT NULL CHECK (status IN ('available', 'consumed', 'revoked')),
  granted_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE (task_id, agent_id),
  CHECK (publisher_wallet <> agent_owner_wallet),
  CHECK ((status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status <> 'consumed' AND consumed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS reputation_v2_reviews (
  review_id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE
    REFERENCES reputation_v2_review_eligibilities(order_id) ON DELETE RESTRICT,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  reviewer_wallet text NOT NULL CHECK (reviewer_wallet ~ '^0x[0-9a-f]{40}$'),
  agent_owner_wallet text NOT NULL CHECK (agent_owner_wallet ~ '^0x[0-9a-f]{40}$'),
  quality_score numeric(7,6) NOT NULL CHECK (quality_score BETWEEN 0 AND 1),
  timeliness_score numeric(7,6) NOT NULL CHECK (timeliness_score BETWEEN 0 AND 1),
  communication_score numeric(7,6) NOT NULL CHECK (communication_score BETWEEN 0 AND 1),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'refunded', 'disputed')),
  dispute_attribution text NOT NULL
    CHECK (dispute_attribution IN ('none', 'agent', 'publisher', 'shared', 'unresolved')),
  order_value_atomic numeric(78,0) NOT NULL CHECK (order_value_atomic > 0),
  reason_codes text[] NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, agent_id),
  CHECK (reviewer_wallet <> agent_owner_wallet)
);

CREATE INDEX IF NOT EXISTS idx_reputation_v2_reviews_agent_window
  ON reputation_v2_reviews (agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_reputation_v2_team_eligibility
  ON reputation_v2_review_eligibilities (task_id, status, agent_id);

COMMIT;
