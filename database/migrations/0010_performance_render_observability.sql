BEGIN;

SET LOCAL search_path TO agent_market, public;

ALTER TABLE performance_samples
  ADD COLUMN IF NOT EXISTS fps numeric(8, 3) CHECK (fps BETWEEN 0 AND 240),
  ADD COLUMN IF NOT EXISTS frame_time_p95_ms numeric(12, 3) CHECK (frame_time_p95_ms BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS dropped_frame_ratio numeric(8, 6) CHECK (dropped_frame_ratio BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS frame_sample_count integer CHECK (frame_sample_count BETWEEN 0 AND 100000),
  ADD COLUMN IF NOT EXISTS frame_window_duration_ms numeric(12, 3) CHECK (frame_window_duration_ms BETWEEN 0 AND 60000),
  ADD COLUMN IF NOT EXISTS hydration_duration_ms numeric(12, 3) CHECK (hydration_duration_ms BETWEEN 0 AND 300000),
  ADD COLUMN IF NOT EXISTS render_mode text CHECK (render_mode IN ('hydrate', 'csr', 'unknown')),
  ADD COLUMN IF NOT EXISTS render_outcome text CHECK (render_outcome IN ('hydrated', 'csr', 'csr-fallback', 'not-observed')),
  ADD COLUMN IF NOT EXISTS recoverable_error_count integer NOT NULL DEFAULT 0 CHECK (recoverable_error_count BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS fallback_count integer NOT NULL DEFAULT 0 CHECK (fallback_count BETWEEN 0 AND 1);

COMMIT;
