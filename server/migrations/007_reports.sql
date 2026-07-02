-- Named reports: a report is a saved composition of dashboard blocks (config JSONB),
-- owned by a user, optionally emailed on a schedule ('none' | 'weekly' | 'monthly').
-- last_sent_at gates the scheduler against double-sends. Idempotent per the migration runner.
CREATE TABLE IF NOT EXISTS reports (
  id           SERIAL PRIMARY KEY,
  uid          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule     TEXT NOT NULL DEFAULT 'none',
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_uid_idx ON reports(uid);
