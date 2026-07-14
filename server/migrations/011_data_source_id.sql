-- Tenancy phase B (canonical-source-identity invariant): source_id on the data tables so reads canonicalise per
-- external property. Columns stay nullable, indexes NON-unique (two linked channels may still each
-- write their own rows until phase C flips the write conflict-targets); readers de-duplicate with
-- DISTINCT ON. ADDITIVE-ONLY + idempotent — rollback is a git revert.

ALTER TABLE channel_daily ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);
UPDATE channel_daily d SET source_id = c.source_id
FROM channels c WHERE d.channel_id = c.id AND d.source_id IS NULL AND c.source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS channel_daily_source_day_idx ON channel_daily(source_id, day DESC) WHERE source_id IS NOT NULL;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);
UPDATE posts p SET source_id = c.source_id
FROM channels c WHERE p.channel_id = c.id AND p.source_id IS NULL AND c.source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS posts_source_date_idx ON posts(source_id, date_published DESC) WHERE source_id IS NOT NULL;

ALTER TABLE velocity_daily ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);
UPDATE velocity_daily v SET source_id = c.source_id
FROM channels c WHERE v.channel_id = c.id AND v.source_id IS NULL AND c.source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS velocity_source_day_idx ON velocity_daily(source_id, day DESC) WHERE source_id IS NOT NULL;

ALTER TABLE mentions ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);
UPDATE mentions m SET source_id = c.source_id
FROM channels c WHERE m.owner_channel_id = c.id AND m.source_id IS NULL AND c.source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mentions_source_idx ON mentions(source_id, post_date DESC) WHERE source_id IS NOT NULL;

-- IG dailies canonicalise through the IG account's source (hybrid channels: the IG source).
ALTER TABLE ig_daily ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);
UPDATE ig_daily d SET source_id = a.source_id
FROM ig_accounts a WHERE d.channel_id = a.channel_id AND d.source_id IS NULL AND a.source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ig_daily_source_day_idx ON ig_daily(source_id, day DESC) WHERE source_id IS NOT NULL;

ALTER TABLE ig_media_daily ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES external_sources(id);
UPDATE ig_media_daily d SET source_id = a.source_id
FROM ig_accounts a WHERE d.channel_id = a.channel_id AND d.source_id IS NULL AND a.source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ig_media_daily_source_idx ON ig_media_daily(source_id, day DESC) WHERE source_id IS NOT NULL;
