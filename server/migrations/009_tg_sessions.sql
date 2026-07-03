-- ── Telegram QR-connected sessions (managed model) ──
-- When a user connects Telegram by scanning a QR code (MTProto auth.exportLoginToken via the
-- Telethon service), we capture their user session and store it ENCRYPTED at rest
-- (AES-256-GCM via TG_SESSION_KEY) — never in plaintext. A Telegram StringSession = full access
-- to that account, so this table is the most sensitive in the schema.
--
-- One session per user account: it covers EVERY channel where that user is an admin. The
-- channels they choose to track live in `channels` (source='qr') and reach this session via
-- owner_uid. The collector model (session stays on the user's own machine) remains available
-- and stores NOTHING here.
CREATE TABLE IF NOT EXISTS tg_sessions (
  uid          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_user_id   BIGINT,
  username     TEXT,
  session_enc  TEXT NOT NULL,            -- AES-256-GCM, format ivHex:tagHex:cipherHex
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
