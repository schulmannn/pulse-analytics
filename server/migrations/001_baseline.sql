-- Baseline schema for fresh installs and idempotent adoption by existing databases.
CREATE TABLE IF NOT EXISTS channel_daily (
  day DATE PRIMARY KEY,
  subscribers INTEGER, joins INTEGER, leaves INTEGER,
  views INTEGER, forwards INTEGER, reactions INTEGER,
  captured_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posts (
  post_id BIGINT PRIMARY KEY,
  date_published TIMESTAMPTZ,
  views INTEGER, reactions INTEGER, forwards INTEGER, replies INTEGER,
  erv NUMERIC, virality NUMERIC, media_type TEXT, caption TEXT, hashtags JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mentions (
  channel_id BIGINT, msg_id BIGINT,
  post_date TIMESTAMPTZ, first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
  title TEXT, username TEXT, link TEXT, snippet TEXT, views INTEGER, query TEXT,
  PRIMARY KEY (channel_id, msg_id)
);

CREATE TABLE IF NOT EXISTS bugs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium',
  text TEXT NOT NULL,
  context TEXT
);
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bug';

CREATE TABLE IF NOT EXISTS bug_attachments (
  id SERIAL PRIMARY KEY,
  bug_id INTEGER REFERENCES bugs(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bug_attachments_bug_id_idx ON bug_attachments(bug_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_prefs (
  uid INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id SERIAL PRIMARY KEY,
  uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_hash_idx ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS email_tokens_uid_kind_idx ON email_tokens(uid, kind);

CREATE TABLE IF NOT EXISTS velocity_daily (
  day DATE PRIMARY KEY,
  data JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id            SERIAL PRIMARY KEY,
  owner_uid     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tg_channel_id BIGINT,
  username      TEXT,
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  source        TEXT NOT NULL DEFAULT 'collector',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channels_owner_idx ON channels(owner_uid);
CREATE UNIQUE INDEX IF NOT EXISTS channels_owner_tgid_uniq
  ON channels(owner_uid, tg_channel_id) WHERE tg_channel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channels_one_central
  ON channels(source) WHERE source = 'central';

ALTER TABLE channel_daily ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_daily_pkey') THEN
  ALTER TABLE channel_daily DROP CONSTRAINT channel_daily_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS channel_daily_chan_day_uniq ON channel_daily(channel_id, day);
CREATE INDEX IF NOT EXISTS channel_daily_chan_idx ON channel_daily(channel_id);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='posts_pkey') THEN
  ALTER TABLE posts DROP CONSTRAINT posts_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS posts_chan_post_uniq ON posts(channel_id, post_id);
CREATE INDEX IF NOT EXISTS posts_chan_idx ON posts(channel_id);

ALTER TABLE velocity_daily ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='velocity_daily_pkey') THEN
  ALTER TABLE velocity_daily DROP CONSTRAINT velocity_daily_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS velocity_chan_day_uniq ON velocity_daily(channel_id, day);

ALTER TABLE mentions ADD COLUMN IF NOT EXISTS owner_channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mentions_pkey') THEN
  ALTER TABLE mentions DROP CONSTRAINT mentions_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS mentions_owner_src_msg_uniq
  ON mentions(owner_channel_id, channel_id, msg_id);
CREATE INDEX IF NOT EXISTS mentions_owner_idx ON mentions(owner_channel_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uniq ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_channel_idx ON api_keys(channel_id);

CREATE TABLE IF NOT EXISTS channel_snapshots (
  channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
