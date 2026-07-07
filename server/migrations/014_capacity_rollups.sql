-- Capacity scaling (ops/CAPACITY_SCALE_1K_10K.md): a per-month rollup of channel_daily so the
-- history-heavy read path can serve long ranges from ~24 monthly rows instead of scanning up to 730
-- daily rows per channel (and re-probing channels once per row for the ADR-001 source trust check).
-- ADDITIVE-ONLY + idempotent: new table + indexes, no data migration, rollback = git revert. The
-- table stays EMPTY until the nightly rollup is enabled (CAPACITY_ROLLUPS=1) — inert by default, so
-- shipping this changes nothing at runtime until an operator opts in and a reader is wired.

CREATE TABLE IF NOT EXISTS channel_monthly (
  channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_id        INTEGER REFERENCES external_sources(id),   -- canonical key (ADR-001); NULL until stamped
  month            DATE NOT NULL,                             -- first day of the month (date_trunc)
  subscribers_end  INTEGER,                                   -- subscriber level on the last captured day
  joins_sum        BIGINT,
  leaves_sum       BIGINT,
  views_sum        BIGINT,
  forwards_sum     BIGINT,
  reactions_sum    BIGINT,
  days_count       INTEGER NOT NULL DEFAULT 0,                -- daily rows folded into this bucket
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, month)
);

-- Canonical read index (ADR-001 phase B): a shared source's monthly series, newest month first.
CREATE INDEX IF NOT EXISTS channel_monthly_source_month_idx
  ON channel_monthly(source_id, month DESC) WHERE source_id IS NOT NULL;
