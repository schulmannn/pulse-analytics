-- 026: tenant-scope the legacy GLOBAL Instagram tag archive (ig_tags).
--
-- 005 created ig_tags as ONE global archive keyed by `media_id` alone: every account's @-mentions
-- landed in a single table with no channel scope, so any per-channel read would leak another
-- tenant's/workspace's tags. This migration keys the archive PER CHANNEL, mirroring ig_daily /
-- ig_media_daily (both scoped by channel_id, source_id stamped from ig_accounts):
--   • channel_id — the owning tenant. NULLABLE on purpose: legacy pre-scope rows keep channel_id
--     NULL and are QUARANTINED. We never invent ownership for them, and no tenant read returns a
--     NULL-channel row (every reader filters `channel_id = $1`). They survive untouched until an
--     explicit, defensible ownership mapping exists.
--   • source_id  — canonical IG source parity with ig_daily (stamped from ig_accounts on write).
-- Forward-only + idempotent (ADD COLUMN IF NOT EXISTS / DROP … IF EXISTS / CREATE INDEX IF NOT EXISTS).

ALTER TABLE ig_tags ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE ig_tags ADD COLUMN IF NOT EXISTS source_id  INTEGER REFERENCES external_sources(id);

-- Drop the legacy single-column PRIMARY KEY (media_id): the SAME media id must be able to exist under
-- DISTINCT channel scopes (a tag on shared / co-followed media is not one global row).
ALTER TABLE ig_tags DROP CONSTRAINT IF EXISTS ig_tags_pkey;

-- Scoped uniqueness / upsert conflict target: one row per (channel_id, media_id). New writes always
-- carry a non-null channel_id, so ON CONFLICT (channel_id, media_id) matches this index. Legacy
-- NULL-channel rows sort as DISTINCT under SQL-NULL semantics, so they neither collide with each
-- other nor ever become a scoped upsert's conflict target — they just sit quarantined.
CREATE UNIQUE INDEX IF NOT EXISTS ig_tags_channel_media_idx ON ig_tags (channel_id, media_id);

-- Read path: newest-first within a single channel scope (replaces the old global posted_at index —
-- there is no global read anymore).
CREATE INDEX IF NOT EXISTS ig_tags_channel_posted_idx ON ig_tags (channel_id, posted_at DESC NULLS LAST);
DROP INDEX IF EXISTS ig_tags_posted_idx;
