-- 022_channel_tg_access_hash.sql
-- Persist the Telegram entity access_hash for QR/central channels so managed collection
-- (mtproto /qr/collect) can address a PRIVATE channel directly via InputPeerChannel(id, hash)
-- instead of scanning iter_dialogs(limit=1000) on every collect just to recover the hash from a
-- fresh StringSession's entity cache.
--
-- access_hash is a signed 64-bit Telegram value (int64) tied to (this owner's account, channel):
-- it is stored as BIGINT and carried end-to-end as a decimal STRING (pg int8 → JS string → Python
-- int), never coerced through a JS Number. It is NEVER logged, returned to the browser, or written
-- into channel_snapshots — it only travels the private web↔mtproto channel next to the session.
--
-- tg_access_hash_version is an optimistic generation guard mirroring tg_sessions.session_version:
-- a persist only wins when its generation still equals the owner's current tg_sessions generation
-- and is >= the stored one, so a late result from before reconnect can never clobber a newer hash.
-- Old rows keep NULL columns and transparently fall back to the one-time cold dialog resync.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS tg_access_hash         BIGINT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS tg_access_hash_version BIGINT;
