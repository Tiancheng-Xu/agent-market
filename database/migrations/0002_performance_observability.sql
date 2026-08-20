BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_market;
SET LOCAL search_path TO agent_market, public;

CREATE TABLE performance_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  route text NOT NULL CHECK (route LIKE '/%' AND length(route) <= 256),
  build_version text NOT NULL CHECK (length(build_version) <= 64),
  observed_at timestamptz NOT NULL,
  ttfb_ms numeric(12, 3),
  fcp_ms numeric(12, 3),
  lcp_ms numeric(12, 3),
  cls numeric(12, 6),
  inp_ms numeric(12, 3),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(ttfb_ms, fcp_ms, lcp_ms, cls, inp_ms) > 0)
);

CREATE TABLE performance_runs (
  id uuid PRIMARY KEY,
  source_request_id uuid NOT NULL REFERENCES performance_samples(request_id),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  sample_count integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  p50_lcp_ms numeric(12, 3),
  p75_lcp_ms numeric(12, 3),
  p95_lcp_ms numeric(12, 3),
  error_rate numeric(8, 6) CHECK (error_rate BETWEEN 0 AND 1),
  task_exit_code integer,
  evidence_status text NOT NULL DEFAULT 'pending'
    CHECK (evidence_status IN ('pending', 'verified', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_performance_samples_route_observed
  ON performance_samples (route, observed_at DESC);

CREATE INDEX idx_performance_runs_status_created
  ON performance_runs (evidence_status, created_at DESC);

COMMIT;
