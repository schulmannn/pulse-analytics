'use strict';

/* ── Integrations repo (P2 db-split, PR 4) ───────────────────────────────────────────────────────
   Внешние подключения и их секреты — ОТДЕЛЬНО от channels (другой lifecycle): IG-аккаунты
   (per-channel OAuth: токен/refresh/удаление), Telegram QR-сессии (per-uid StringSession),
   IG-теги (@-упоминания в чужих медиа) и connection-status коллектора. Извлечено ДОСЛОВНО из
   db.js — SQL не менялся. Публичный `db.*` API не меняется: db.js спредит методы этого репо.

   СЕКРЕТЫ: access_token_enc / session_enc приходят и отдаются УЖЕ шифрованными — callers
   шифруют/дешифруют через lib/ig_crypto / lib/tg_crypto; repo (как раньше db.js) не видит
   plaintext и НИКОГДА не должен его логировать.

   Зависимости: pool + enabled (инъекция), transaction (инъекция),
   ensureExternalSource — ИНЪЕКЦИЯ из composition-root (db.js передаёт sourcesRepo.ensureExternalSource;
   finding 8 — external identity отдельный домен): репозитории не импортят друг друга, связывание — в фасаде. */

// ── TG session connection-health (017_tg_session_health) ──────────────────────
// Allow-lists ГАРАНТИРУЮТ, что в БД попадают только валидные, НЕ-секретные значения — даже если
// вызывающий передал что-то произвольное (session-material / upstream-текст / SQL). Именно repo —
// единственная точка записи health, поэтому санитайзинг живёт здесь, а не в джобе.
const TG_HEALTH_FAILURE_STATES = new Set(['reauth_required', 'degraded']);
const TG_HEALTH_ERROR_CODES = new Set([
  'session_unauthorized', 'mtproto_session_unauthorized',
  'mtproto_timeout', 'mtproto_unreachable', 'mtproto_error', 'internal_error',
  'flood_wait', 'collect_failed', 'unknown',
]);

// pg returns BIGINT as a string. Accept only a positive decimal generation and pass it back as a
// bound value; never interpolate it into SQL.
function safeTgSessionVersion(value) {
  const text = String(value ?? '');
  return /^[1-9]\d*$/.test(text) ? text : null;
}

function createIntegrationsRepo({ pool, enabled, ensureExternalSource, transaction }) {
  // ig-tags: upsert (write) → collectorRepo, чтение → analyticsRepo (finding 7, PR 9) —
  // integrationsRepo остаётся домен секретов/OAuth-lifecycle.

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
    // Reconnect = свежая, только что отсканированная валидная сессия: health сбрасывается в
    // 'healthy' и протухшие error-поля чистятся, чтобы CTA «переподключить» сразу исчез. Меняется
    // ТОЛЬКО эта строка — tracked-каналы (source='qr') и их история живут в channels/*_daily/posts
    // и здесь не затрагиваются (upsert по uid не каскадит на них).
    await pool.query(
      `INSERT INTO tg_sessions (uid, tg_user_id, username, session_enc, connection_state, session_version, updated_at)
       VALUES ($1,$2,$3,$4,'healthy',1,now())
       ON CONFLICT (uid) DO UPDATE SET
         tg_user_id=EXCLUDED.tg_user_id, username=EXCLUDED.username,
         session_enc=EXCLUDED.session_enc, connection_state='healthy',
         session_version=tg_sessions.session_version + 1,
         last_error_code=NULL, last_error_at=NULL, updated_at=now()`,
      [uid, tg_user_id || null, username || null, session_enc]);
    return true;
  }

  // Lazy re-encryption after a TG_SESSION_KEY rotation: rewrite ONLY the ciphertext (+ updated_at) for
  // ONE specific session generation. Deliberately narrow — it NEVER bumps session_version, touches
  // identity (tg_user_id/username) or connection health, so a concurrent reconnect (which increments
  // session_version) makes this a safe no-op instead of clobbering the fresh session. sessionEnc comes
  // in already-encrypted (caller re-encrypts via lib/tg_crypto); the repo never sees plaintext. Returns
  // whether a row matched the (uid, version) generation guard (rowCount=0 = race, normal).
  async function rotateTgSessionCiphertext(uid, sessionVersion, sessionEnc) {
    const version = safeTgSessionVersion(sessionVersion);
    if (!enabled || !uid || !version || !sessionEnc) return false;
    const { rowCount } = await pool.query(
      'UPDATE tg_sessions SET session_enc=$3, updated_at=now() WHERE uid=$1 AND session_version=$2',
      [uid, version, sessionEnc]);
    return rowCount > 0;
  }

  // Full row incl. the encrypted session (callers decrypt) + public health fields. Returns null
  // when not connected. connection_state/last_* — НЕ-секретные, /api/tg/qr/status их отдаёт клиенту.
  async function getTgSession(uid) {
    if (!enabled || !uid) return null;
    const { rows } = await pool.query(
      `SELECT uid, tg_user_id, username, session_enc, connection_state, session_version,
              to_char(connected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at,
              to_char(last_attempt_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_attempt_at,
              to_char(last_success_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_success_at,
              last_error_code,
              to_char(last_error_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_error_at
         FROM tg_sessions WHERE uid=$1`, [uid]);
    return rows[0] || null;
  }

  async function deleteTgSession(uid) {
    if (!enabled || !uid) return false;
    const { rowCount } = await pool.query('DELETE FROM tg_sessions WHERE uid=$1', [uid]);
    return rowCount > 0;
  }

  // Every stored session (encrypted) + health fields. Internal use only (the daily cron decrypts
  // each to collect that user's QR-connected channels, and reads health to decide bookkeeping).
  // Never expose session_enc outside the server.
  async function listTgSessions() {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT uid, tg_user_id, username, session_enc, connection_state, session_version,
              to_char(last_attempt_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_attempt_at,
              to_char(last_success_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_success_at,
              last_error_code,
              to_char(last_error_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_error_at
         FROM tg_sessions ORDER BY uid ASC`);
    return rows;
  }

  // ── TG session health bookkeeping (set by the QR-collection job) ─────────────
  // Три узких, single-purpose метода. Состояние и код НЕ приходят от клиента как свободный текст —
  // это фиксированные значения из джобы, а recordTgSessionFailure дополнительно прогоняет их через
  // allow-list, поэтому caller-controlled SQL/state невозможен. Все возвращают boolean (была ли строка).

  // Реальная (стартовавшая) попытка сбора. Пропущенные идемпотентные прогоны попыткой НЕ считаются —
  // джоба зовёт это только когда хотя бы один сбор действительно стартовал.
  async function recordTgSessionAttempt(uid, sessionVersion) {
    const version = safeTgSessionVersion(sessionVersion);
    if (!enabled || !uid || !version) return false;
    const { rowCount } = await pool.query(
      'UPDATE tg_sessions SET last_attempt_at=now() WHERE uid=$1 AND session_version=$2', [uid, version]);
    return rowCount > 0;
  }

  // Успешный сбор: health → healthy, штамп last_success_at, протухшая ошибка снимается. Зовётся
  // ТОЛЬКО после того, как persistTgBundle реально записал бандл (не на skip и не на throw).
  async function recordTgSessionSuccess(uid, sessionVersion) {
    const version = safeTgSessionVersion(sessionVersion);
    if (!enabled || !uid || !version) return false;
    const { rowCount } = await pool.query(
      `UPDATE tg_sessions
          SET connection_state='healthy', last_attempt_at=now(), last_success_at=now(),
              last_error_code=NULL, last_error_at=NULL
        WHERE uid=$1 AND session_version=$2`, [uid, version]);
    return rowCount > 0;
  }

  // Сбой сбора. state ∈ {reauth_required, degraded} (иначе → degraded), errorCode ∈ allow-list
  // (иначе → 'unknown'). НИКАКОГО upstream-текста/секрета в БД — только санитизированный код.
  async function recordTgSessionFailure(uid, sessionVersion, { state, errorCode } = {}) {
    const version = safeTgSessionVersion(sessionVersion);
    if (!enabled || !uid || !version) return false;
    const safeState = TG_HEALTH_FAILURE_STATES.has(state) ? state : 'degraded';
    const safeCode = TG_HEALTH_ERROR_CODES.has(errorCode) ? errorCode : 'unknown';
    const { rowCount } = await pool.query(
      `UPDATE tg_sessions
          SET connection_state=$3, last_attempt_at=now(), last_error_code=$4, last_error_at=now()
        WHERE uid=$1 AND session_version=$2`, [uid, version, safeState, safeCode]);
    return rowCount > 0;
  }

  // getCollectorStatus (read) → analyticsRepo (finding 7, PR 9).

  return {
    saveIgAccount, getIgAccount, updateIgToken, deleteIgAccount, listIgAccounts,
    saveTgSession, getTgSession, deleteTgSession, listTgSessions, rotateTgSessionCiphertext,
    recordTgSessionAttempt, recordTgSessionSuccess, recordTgSessionFailure,
  };
}

module.exports = {
  createIntegrationsRepo,
  TG_HEALTH_FAILURE_STATES,
  TG_HEALTH_ERROR_CODES,
  safeTgSessionVersion,
};
