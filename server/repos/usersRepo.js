'use strict';

/* ── Users / accounts repo (P2 db-split, PR 2) ───────────────────────────────────────────────────
   Аккаунты, аватары, статусы/роли, ревокация сессий (token_version), email-токены (verify/reset) и
   пользовательские prefs. Извлечено ДОСЛОВНО из db.js — SQL не менялся. Публичный `db.*` API не
   меняется: db.js спредит методы этого репо в module.exports.

   Зависит только от общего пула + флага enabled (инъекция). Внутренних импортов db.js/других repo нет.
   ТЕРМИНОЛОГИЯ: `role` здесь — ГЛОБАЛЬНАЯ системная роль (user|superuser), НЕ путать с
   workspace_members.role (owner|admin|member). Концептуально это `system_role`; физическую колонку
   пока оставляем `role` (переименование — отдельная миграция). */

const USER_ROLES = ['user', 'superuser'];
const USER_STATUSES = ['unverified', 'pending', 'active', 'disabled'];

function createUsersRepo({ pool, enabled }) {
  async function countUsers() {
    if (!enabled) return 0;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    return rows[0].n;
  }

  async function createUser({ email, pass_hash, role, status }) {
    if (!enabled) return null;
    const r = USER_ROLES.includes(role) ? role : 'user';
    const s = USER_STATUSES.includes(status) ? status : 'pending';
    const { rows } = await pool.query(
      `INSERT INTO users (email, pass_hash, role, status) VALUES ($1,$2,$3,$4)
       RETURNING id, email, role, status, token_version,
         to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
      [String(email).toLowerCase().trim(), pass_hash, r, s]);
    return rows[0];
  }

  async function getUserByEmail(email) {
    if (!enabled) return null;
    const { rows } = await pool.query(
      'SELECT id, email, pass_hash, role, status, token_version FROM users WHERE email=$1',
      [String(email).toLowerCase().trim()]);
    return rows[0] || null;
  }

  async function getUserById(id) {
    if (!enabled) return null;
    const { rows } = await pool.query(
      'SELECT id, email, role, status, token_version FROM users WHERE id=$1', [id]);
    return rows[0] || null;
  }

  // Avatar kept off getUserById (which runs on every auth lookup) — fetched only when /me asks.
  async function getUserAvatar(id) {
    if (!enabled) return null;
    const { rows } = await pool.query('SELECT avatar_url FROM users WHERE id=$1', [id]);
    return rows[0] ? rows[0].avatar_url : null;
  }
  async function setUserAvatar(id, dataUrl) {
    if (!enabled) return;
    await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [dataUrl, id]);
  }

  async function listUsers() {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT id, email, role, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM users ORDER BY created_at ASC`);
    return rows;
  }

  async function updateUser(id, { role, status }) {
    if (!enabled) return null;
    const sets = [], vals = [];
    let i = 1;
    if (role != null)   { if (!USER_ROLES.includes(role))     throw new Error('bad role');   sets.push(`role=$${i++}`);   vals.push(role); }
    if (status != null) { if (!USER_STATUSES.includes(status)) throw new Error('bad status'); sets.push(`status=$${i++}`); vals.push(status); }
    if (!sets.length) return getUserById(id);
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}, token_version=token_version+1 WHERE id=$${i}
       RETURNING id, email, role, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`, vals);
    return rows[0] || null;
  }

  async function setUserPassword(id, pass_hash) {
    if (!enabled) return false;
    await pool.query(
      'UPDATE users SET pass_hash=$2, token_version=token_version+1 WHERE id=$1',
      [id, pass_hash]);
    return true;
  }

  async function revokeUserSessions(id) {
    if (!enabled || id == null) return false;
    const { rowCount } = await pool.query(
      'UPDATE users SET token_version=token_version+1 WHERE id=$1', [id]);
    return rowCount > 0;
  }

  async function setUserStatus(id, status) {
    if (!enabled) return null;
    if (!USER_STATUSES.includes(status)) throw new Error('bad status');
    const { rows } = await pool.query(
      `UPDATE users SET status=$2, token_version=token_version+1
        WHERE id=$1 RETURNING id, email, role, status, token_version`, [id, status]);
    return rows[0] || null;
  }

  // ── Email tokens (verify / reset) ─────────────────────────────────
  // Issuing a new token of a kind invalidates the user's prior unused ones of that
  // kind, so only the latest emailed link works.
  async function createEmailToken(uid, kind, tokenHash, expiresAt) {
    if (!enabled) return null;
    // Per-account cooldown (independent of IP rate-limit): at most one email per
    // minute per uid+kind → blocks email-bombing a victim / burning the send quota.
    // Кулдаун-чек, инвалидация и INSERT — в одной транзакции под advisory-локом (uid+kind):
    // раньше это были три автокоммита, и два конкурентных запроса оба проходили чек —
    // две живые ссылки в двух письмах, кулдаун в обход.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('email_token:' || $1::text || ':' || $2))", [uid, kind]);
      const recent = await client.query(
        "SELECT 1 FROM email_tokens WHERE uid=$1 AND kind=$2 AND created_at > now() - interval '60 seconds' LIMIT 1", [uid, kind]);
      if (recent.rows.length) { await client.query('ROLLBACK'); return null; }
      await client.query('UPDATE email_tokens SET used_at=now() WHERE uid=$1 AND kind=$2 AND used_at IS NULL', [uid, kind]);
      const { rows } = await client.query(
        'INSERT INTO email_tokens (uid, kind, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [uid, kind, tokenHash, expiresAt]);
      await client.query('COMMIT');
      return rows[0] ? rows[0].id : null;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  // Atomically consume a token: single-use + expiry enforced in one UPDATE … RETURNING,
  // so concurrent double-clicks can't both succeed. Returns { uid } or null.
  async function useEmailToken(tokenHash, kind) {
    if (!enabled) return null;
    const { rows } = await pool.query(
      `UPDATE email_tokens SET used_at=now()
         WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at > now()
         RETURNING uid`, [tokenHash, kind]);
    return rows[0] ? { uid: rows[0].uid } : null;
  }

  // ── Пользовательские prefs (per-uid JSONB, upsert) ────────────────
  async function getPrefs(uid) {
    if (!enabled || uid == null) return null;
    const { rows } = await pool.query('SELECT prefs FROM user_prefs WHERE uid=$1', [uid]);
    return rows[0] ? rows[0].prefs : null;
  }

  async function setPrefs(uid, prefs) {
    if (!enabled || uid == null) return false;
    await pool.query(
      `INSERT INTO user_prefs (uid, prefs, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (uid) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
      [uid, prefs]
    );
    return true;
  }

  return {
    USER_ROLES, USER_STATUSES,
    countUsers, createUser, getUserByEmail, getUserById, getUserAvatar, setUserAvatar,
    listUsers, updateUser, setUserPassword, revokeUserSessions, setUserStatus,
    createEmailToken, useEmailToken, getPrefs, setPrefs,
  };
}

module.exports = { createUsersRepo };
