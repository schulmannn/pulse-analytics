-- ── Instagram connection (Instagram API with Instagram Login) — per-channel ──
-- One Instagram *professional* account (Business or Creator) connected per channel/tenant
-- via OAuth (no Facebook Page required). The long-lived Instagram user access token is stored
-- ENCRYPTED at rest (AES-256-GCM via IG_TOKEN_KEY) — never in plaintext. `token_expires_at`
-- drives the ~60-day refresh. Replaces the single global IG_ACCESS_TOKEN/IG_ACCOUNT_ID env model.
CREATE TABLE IF NOT EXISTS ig_accounts (
  channel_id       INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  ig_user_id       TEXT NOT NULL,
  username         TEXT,
  access_token_enc TEXT NOT NULL,            -- AES-256-GCM, format: ivHex:tagHex:cipherHex
  token_expires_at TIMESTAMPTZ,
  scopes           TEXT,
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
