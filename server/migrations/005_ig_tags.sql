-- Instagram "tags" — media where our Instagram account is @-tagged on someone else's photo
-- (the closest thing to brand mentions Instagram's API exposes; there is no public keyword search).
-- The live /{ig-id}/tags edge only returns recent items, so we archive them here: upsert by media
-- id, with first_seen/last_seen tracking observation. Global for the single env-configured account
-- for now (per-channel arrives with the OAuth migration).
CREATE TABLE IF NOT EXISTS ig_tags (
  media_id       TEXT PRIMARY KEY,
  username       TEXT,
  caption        TEXT,
  permalink      TEXT,
  media_type     TEXT,
  like_count     INTEGER,
  comments_count INTEGER,
  posted_at      TIMESTAMPTZ,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ig_tags_posted_idx ON ig_tags(posted_at DESC NULLS LAST);
