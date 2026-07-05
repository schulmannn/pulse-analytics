-- Background job idempotency (roadmap P0): one row per logical unit of work, keyed by
-- (kind, idempotency_key) — e.g. ('ig_daily', 'source:42:2026-07-04'). Duplicate enqueues collapse
-- onto the existing row; a crashed runner's lease expires and the job becomes claimable again;
-- a succeeded job returns its cached result instead of re-running. See server/lib/jobs.js.

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  payload JSONB,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_claimable_idx ON jobs(kind, status, locked_until);
