-- ── МойСклад: durable archive of customer sales returns ────────────────────────
-- Returns are a separate flow and are not subtracted from ms_orders/ms_daily revenue.
-- Upstream documents may be corrected after creation, so repeated collection replaces
-- the stored row. Absence from a bounded page is never treated as deletion.
CREATE TABLE IF NOT EXISTS ms_returns (
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  return_id    TEXT NOT NULL,
  moment       TIMESTAMPTZ NOT NULL,
  sum_kopecks  BIGINT NOT NULL,
  agent_id     TEXT,
  agent_name   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, return_id)
);

CREATE INDEX IF NOT EXISTS ms_returns_channel_moment_idx
  ON ms_returns (channel_id, moment);

-- Separate cursor: order archives may already be done when this migration lands. Sharing
-- ms_backfill_state would therefore skip historical returns for existing accounts.
CREATE TABLE IF NOT EXISTS ms_returns_backfill_state (
  channel_id      INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle','running','done','error')),
  cursor_from     DATE,
  total_estimate  INTEGER,
  fetched_count   INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
