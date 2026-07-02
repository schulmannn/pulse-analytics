-- Timeline annotations (F1): per-channel event markers (campaign / launch / algorithm change)
-- shown on the trend charts to explain spikes. Owned via the channel (tenant); created_by kept
-- for display/audit and nulled if the user is removed. Idempotent per the migration runner.
CREATE TABLE IF NOT EXISTS chart_annotations (
  id          SERIAL PRIMARY KEY,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  label       TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chart_annotations_channel_day_idx ON chart_annotations(channel_id, day);
