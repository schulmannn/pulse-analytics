-- Session revocation without storing raw session tokens.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Idempotency ledger for collector deliveries. A repeated (channel_id, ingest_id)
-- returns the stored result instead of applying the payload twice.
CREATE TABLE IF NOT EXISTS ingest_receipts (
  channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ingest_id         TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  collector_version TEXT,
  collected_at      TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'processing',
  payload_hash      TEXT NOT NULL,
  result            JSONB,
  error             TEXT,
  PRIMARY KEY (channel_id, ingest_id)
);
CREATE INDEX IF NOT EXISTS ingest_receipts_received_idx
  ON ingest_receipts(channel_id, received_at DESC);

-- Cheap operational view used by the UI/alerts: no need to scan all receipts.
CREATE TABLE IF NOT EXISTS collector_status (
  channel_id        INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  collector_version TEXT,
  last_ingest_id    TEXT,
  last_attempt_at   TIMESTAMPTZ,
  last_success_at   TIMESTAMPTZ,
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Security-relevant events only; never store passwords, API keys or session tokens.
CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL PRIMARY KEY,
  uid         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel_id  INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  request_id  TEXT,
  ip_hash     TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_uid_created_idx ON audit_events(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_channel_created_idx ON audit_events(channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS channels_owner_status_idx ON channels(owner_uid, status);
CREATE INDEX IF NOT EXISTS channel_snapshots_updated_idx ON channel_snapshots(updated_at DESC);
