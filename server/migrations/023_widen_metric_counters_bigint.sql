-- 023_widen_metric_counters_bigint.sql
-- Widen METRIC COUNTER columns from INTEGER to BIGINT so large real accounts stop being clamped /
-- saturated at INT4 (2_147_483_647). Saturation invents a wrong number; the honest ceiling is the
-- application's MAX_SAFE_METRIC = 9e15 (see server/lib/metricNumber.js), well inside BIGINT range.
--
-- SCOPE — analytics metric counters ONLY. Identifiers stay as they are: channel_id / source_id remain INTEGER
-- FKs, and Telegram/Instagram entity ids (posts.post_id, mentions.channel_id/msg_id, tg_channel_id)
-- are already BIGINT and carried as decimal strings. Serial PKs and operational counters are untouched.
--
-- The target tables are tiny (low hundreds of rows; rollup/tags are empty), so the ACCESS EXCLUSIVE locks and
-- table rewrite this ALTER performs are acceptable during deploy. Runs inside the migration runner's
-- own BEGIN/COMMIT (server/migrations.js) — deliberately NO CONCURRENTLY (illegal in a transaction).
-- int4 -> int8 is a widening cast, so no USING clause and no data change beyond the rewrite.

-- channel_daily: subscriber level + daily flow counters.
ALTER TABLE channel_daily
  ALTER COLUMN subscribers TYPE BIGINT,
  ALTER COLUMN joins       TYPE BIGINT,
  ALTER COLUMN leaves      TYPE BIGINT,
  ALTER COLUMN views       TYPE BIGINT,
  ALTER COLUMN forwards    TYPE BIGINT,
  ALTER COLUMN reactions   TYPE BIGINT;

-- posts: per-post engagement counters (post_id is already BIGINT and stays the identifier).
ALTER TABLE posts
  ALTER COLUMN views     TYPE BIGINT,
  ALTER COLUMN reactions TYPE BIGINT,
  ALTER COLUMN forwards  TYPE BIGINT,
  ALTER COLUMN replies   TYPE BIGINT;

-- mentions: potential-views counter (channel_id / msg_id are already BIGINT identifiers).
ALTER TABLE mentions
  ALTER COLUMN views TYPE BIGINT;

-- ig_daily: account-level daily Instagram counters.
ALTER TABLE ig_daily
  ALTER COLUMN followers          TYPE BIGINT,
  ALTER COLUMN followers_total    TYPE BIGINT,
  ALTER COLUMN reach              TYPE BIGINT,
  ALTER COLUMN views              TYPE BIGINT,
  ALTER COLUMN profile_views      TYPE BIGINT,
  ALTER COLUMN accounts_engaged   TYPE BIGINT,
  ALTER COLUMN total_interactions TYPE BIGINT,
  ALTER COLUMN likes              TYPE BIGINT,
  ALTER COLUMN comments           TYPE BIGINT,
  ALTER COLUMN saves              TYPE BIGINT,
  ALTER COLUMN shares             TYPE BIGINT,
  ALTER COLUMN follows            TYPE BIGINT,
  ALTER COLUMN unfollows          TYPE BIGINT;

-- ig_media_daily: per-media lifetime Instagram counters (media_id stays a TEXT identifier).
ALTER TABLE ig_media_daily
  ALTER COLUMN reach    TYPE BIGINT,
  ALTER COLUMN likes    TYPE BIGINT,
  ALTER COLUMN comments TYPE BIGINT,
  ALTER COLUMN saved    TYPE BIGINT,
  ALTER COLUMN shares   TYPE BIGINT,
  ALTER COLUMN views    TYPE BIGINT;

-- Derived monthly level must accept the widened channel_daily subscriber level. Aggregate flow
-- columns were already BIGINT; days_count remains a small operational count.
ALTER TABLE channel_monthly
  ALTER COLUMN subscribers_end TYPE BIGINT;

-- Archived Instagram tag engagement is another browser-facing analytics counter path.
ALTER TABLE ig_tags
  ALTER COLUMN like_count     TYPE BIGINT,
  ALTER COLUMN comments_count TYPE BIGINT;
