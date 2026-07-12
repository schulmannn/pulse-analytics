'use strict';

/* ── Integrations repo (P2 db-split, PR 4) ───────────────────────────────────────────────────────
   Внешние подключения и их секреты — ОТДЕЛЬНО от channels (другой lifecycle): IG-аккаунты
   (per-channel OAuth: токен/refresh/удаление), Telegram QR-сессии (per-uid StringSession),
   IG-теги (@-упоминания в чужих медиа) и connection-status коллектора. Извлечено ДОСЛОВНО из
   db.js — SQL не менялся. Публичный `db.*` API не меняется: db.js спредит методы этого репо.

   СЕКРЕТЫ: access_token_enc / session_enc приходят и отдаются УЖЕ шифрованными — callers
   шифруют/дешифруют через lib/ig_crypto / lib/tg_crypto; repo (как раньше db.js) не видит
   plaintext и НИКОГДА не должен его логировать.

   Зависимости: pool + enabled (инъекция), CHANNEL_ACCESS_PREDICATE из ../db/access (leaf),
   ensureExternalSource — ИНЪЕКЦИЯ из composition-root (db.js передаёт sourcesRepo.ensureExternalSource;
   finding 8 — external identity отдельный домен): репозитории не импортят друг друга, связывание — в фасаде. */

const { CHANNEL_ACCESS_PREDICATE } = require('../db/access');

function createIntegrationsRepo({ pool, enabled, ensureExternalSource, transaction }) {
  // ── Instagram tags (media where we're @-tagged) — archive so they persist past the live edge's window.
  async function upsertIgTags(rows) {
    if (!enabled || !rows || !rows.length) return 0;
    let n = 0;
    for (const r of rows) {
      if (!r || !r.id) continue;
      await pool.query(
        `INSERT INTO ig_tags (media_id, username, caption, permalink, media_type, like_count, comments_count, posted_at, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (media_id) DO UPDATE SET
           username=EXCLUDED.username, caption=EXCLUDED.caption, permalink=EXCLUDED.permalink,
           media_type=EXCLUDED.media_type, like_count=EXCLUDED.like_count,
           comments_count=EXCLUDED.comments_count, posted_at=EXCLUDED.posted_at, last_seen=now()`,
        [String(r.id), r.username || null, r.caption || null, r.permalink || null, r.media_type || null,
         r.like_count != null ? Number(r.like_count) : null, r.comments_count != null ? Number(r.comments_count) : null,
         r.timestamp || null],
      );
      n++;
    }
    return n;
  }
  async function getIgTags(limit = 100) {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT media_id AS id, username, caption, permalink, media_type, like_count, comments_count,
              to_char(posted_at,'YYYY-MM-DD"T"HH24:MI:SS') AS timestamp,
              to_char(first_seen,'YYYY-MM-DD"T"HH24:MI:SS') AS first_seen
       FROM ig_tags ORDER BY posted_at DESC NULLS LAST, first_seen DESC LIMIT $1`, [limit]);
    return rows;
  }

  // ── Instagram accounts (per-channel OAuth connection) ─────────────
  // One IG professional account per channel. The access token is stored already-encrypted
  // (callers encrypt via lib/ig_crypto before persisting) — the repo never sees plaintext.
  async function saveIgAccount(channelId, { ig_user_id, username, access_token_enc, token_expires_at, scopes }) {
    if (!enabled || !channelId) return false;
    // Canonical IG source (ADR-001): find-or-create by ig_user_id and stamp the account row; a
    // standalone IG channel (source='ig', no TG identity) also carries it as its channel source.
    // Три записи (source find-or-create → аккаунт → штамп канала) — одной транзакцией: раньше
    // это были автокоммиты, и падение между ними оставляло аккаунт без source-связки.
    return transaction(async (client) => {
      const srcId = await ensureExternalSource('ig', ig_user_id, { username }, client);
      await client.query(
        `INSERT INTO ig_accounts (channel_id, ig_user_id, username, access_token_enc, token_expires_at, scopes, source_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (channel_id) DO UPDATE SET
           ig_user_id=EXCLUDED.ig_user_id, username=EXCLUDED.username,
           access_token_enc=EXCLUDED.access_token_enc, token_expires_at=EXCLUDED.token_expires_at,
           scopes=EXCLUDED.scopes, source_id=COALESCE(EXCLUDED.source_id, ig_accounts.source_id), updated_at=now()`,
        [channelId, ig_user_id, username || null, access_token_enc, token_expires_at || null, scopes || null, srcId]);
      await client.query(
        `UPDATE channels SET source_id=$2 WHERE id=$1 AND source_id IS NULL AND tg_channel_id IS NULL AND source='ig'`,
        [channelId, srcId]);
      return true;
    });
  }

  // Full row incl. the encrypted token (callers decrypt). Returns null when not connected.
  async function getIgAccount(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT channel_id, ig_user_id, username, access_token_enc, scopes,
              to_char(token_expires_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS token_expires_at,
              to_char(connected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at
         FROM ig_accounts WHERE channel_id=$1`, [channelId]);
    return rows[0] || null;
  }

  // Refresh path: rotate the encrypted token + expiry without touching identity columns.
  async function updateIgToken(channelId, access_token_enc, token_expires_at) {
    if (!enabled || !channelId) return false;
    await pool.query(
      'UPDATE ig_accounts SET access_token_enc=$2, token_expires_at=$3, updated_at=now() WHERE channel_id=$1',
      [channelId, access_token_enc, token_expires_at || null]);
    return true;
  }

  async function deleteIgAccount(channelId) {
    if (!enabled || !channelId) return false;
    const { rowCount } = await pool.query('DELETE FROM ig_accounts WHERE channel_id=$1', [channelId]);
    return rowCount > 0;
  }

  // Every connected IG account (any channel — central OR collector), incl. the encrypted
  // token so a trusted cron can decrypt + fetch. NO ownership filter (unlike getIgAccount's
  // single-channel scope): the daily persistence cron iterates ALL rows. Callers decrypt.
  async function listIgAccounts() {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT channel_id, ig_user_id, username, access_token_enc, scopes,
              to_char(token_expires_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS token_expires_at
         FROM ig_accounts ORDER BY channel_id ASC`);
    return rows;
  }

  // ── Telegram QR sessions (managed connect) ───────────────────────────
  // One encrypted user session per account (callers encrypt via lib/tg_crypto — the repo never sees
  // plaintext). Covers every channel where that user is an admin; QR-connected channels reach it
  // via owner_uid. A StringSession = full account access, so this is the most sensitive row.
  async function saveTgSession(uid, { tg_user_id, username, session_enc }) {
    if (!enabled || !uid) return false;
    await pool.query(
      `INSERT INTO tg_sessions (uid, tg_user_id, username, session_enc, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (uid) DO UPDATE SET
         tg_user_id=EXCLUDED.tg_user_id, username=EXCLUDED.username,
         session_enc=EXCLUDED.session_enc, updated_at=now()`,
      [uid, tg_user_id || null, username || null, session_enc]);
    return true;
  }

  // Full row incl. the encrypted session (callers decrypt). Returns null when not connected.
  async function getTgSession(uid) {
    if (!enabled || !uid) return null;
    const { rows } = await pool.query(
      `SELECT uid, tg_user_id, username, session_enc,
              to_char(connected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at
         FROM tg_sessions WHERE uid=$1`, [uid]);
    return rows[0] || null;
  }

  async function deleteTgSession(uid) {
    if (!enabled || !uid) return false;
    const { rowCount } = await pool.query('DELETE FROM tg_sessions WHERE uid=$1', [uid]);
    return rowCount > 0;
  }

  // Every stored session (encrypted). Internal use only (the daily cron decrypts each to collect that
  // user's QR-connected channels). Never expose session_enc outside the server.
  async function listTgSessions() {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT uid, tg_user_id, username, session_enc FROM tg_sessions`);
    return rows;
  }

  // ── Connection-status коллектора (read; writes живут в ingest) ───────
  async function getCollectorStatus(channelId, user) {
    if (!enabled || !channelId || !user || user.uid == null) return null;
    const { rows } = await pool.query(
      `SELECT s.collector_version, s.last_ingest_id,
              to_char(s.last_attempt_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_attempt_at,
              to_char(s.last_success_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_success_at,
              s.last_error
         FROM collector_status s
         JOIN channels c ON c.id=s.channel_id
        WHERE s.channel_id=$1 AND ${CHANNEL_ACCESS_PREDICATE.replaceAll('channels.', 'c.').replaceAll('$UID', '$2')}`,
      [channelId, user.uid]);
    return rows[0] || null;
  }

  return {
    upsertIgTags, getIgTags,
    saveIgAccount, getIgAccount, updateIgToken, deleteIgAccount, listIgAccounts,
    saveTgSession, getTgSession, deleteTgSession, listTgSessions,
    getCollectorStatus,
  };
}

module.exports = { createIntegrationsRepo };
