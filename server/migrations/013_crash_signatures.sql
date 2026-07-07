-- 013_crash_signatures.sql — dedup ledger for client crashes (POST /api/client-errors).
-- Every crash still lands per-occurrence in `bugs` (kind='crash'); this table collapses them by
-- signature so the Notion sink creates ONE card per unique crash and bumps a repeat counter instead
-- of flooding. Additive + idempotent; a safe no-op when the Notion env is unset.
CREATE TABLE IF NOT EXISTS crash_signatures (
  signature      TEXT PRIMARY KEY,
  scope          TEXT,
  name           TEXT,
  message        TEXT,
  route          TEXT,
  widget_id      TEXT,
  label          TEXT,
  commit_sha     TEXT,
  count          INTEGER NOT NULL DEFAULT 1,
  notion_page_id TEXT,
  last_trace_id  TEXT,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified  TIMESTAMPTZ
);
