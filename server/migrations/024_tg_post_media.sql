-- 024_tg_post_media.sql
-- DB-first persisted cover thumbnails for the central Telegram channel's posts. The open <img>
-- proxy (GET /api/tg/mtproto/thumb/:id) previously fetched every cover LIVE through the MTProto
-- service's global TG_SESSION; once that env session is revoked the proxy 503s and top-post covers
-- vanish on Home/Обзор even though posts and velocity already come DB-first from the owner's managed
-- QR session (#217). This table lets the trusted managed collect (mtproto /qr/collect,
-- include_media=true) capture each post's small JPEG thumbnail once and persist it next to the posts
-- archive, so the proxy serves bytes from Postgres and never depends on the fragile global session.
--
-- Security: the managed session is used ONLY inside the background collect job — anonymous <img>
-- traffic hitting the open proxy reads these persisted PUBLIC bytes, never a decrypted session.
-- `jpeg` is the raw small thumbnail (image/jpeg); `size` mirrors the proxy's ?size (only 'sm' is
-- captured today). The composite FK makes media lifecycle follow the canonical posts archive: a
-- future post-retention policy cannot leave orphaned blobs. Hard CHECK bounds are defence-in-depth
-- against a malformed internal payload growing the database without limit. Kept in a SEPARATE table
-- (not a posts column) so hot analytics queries never drag the blob.
CREATE TABLE IF NOT EXISTS tg_post_media (
  channel_id INTEGER     NOT NULL,
  post_id    BIGINT      NOT NULL CHECK (post_id > 0),
  size       TEXT        NOT NULL DEFAULT 'sm' CHECK (size IN ('sm', 'lg')),
  jpeg       BYTEA       NOT NULL CHECK (octet_length(jpeg) BETWEEN 4 AND 524288),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, post_id, size),
  FOREIGN KEY (channel_id, post_id) REFERENCES posts(channel_id, post_id) ON DELETE CASCADE
);
