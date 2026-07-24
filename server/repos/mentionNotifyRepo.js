'use strict';

/* ── Репо доставки упоминаний (035): привязка бота + личные подписки ─────────────────────────────
   Два домена одной фичи:
     • tg_notify_bindings — uid → личный чат с ботом. Токен deep-link'а хранится ТОЛЬКО хешем
       (sha256 делает роут — репо, как auth-токены, plaintext не видит и не логирует).
     • mention_notify_subscriptions — личная подписка (channel_id, uid). Запись гейтится
       SQL-boundary channelAccessSql (любой, кто ВИДИТ канал: поиск в джобе идёт через
       СОБСТВЕННУЮ сессию подписчика, его же квоту — admin-роль не нужна).

   listRunnableMentionNotifySubscriptions — единственный «широкий» ридер (cron): JOIN включённых
   подписок с завершённой привязкой (chat_id NOT NULL), живой сессией подписчика (не
   reauth_required) и настроенными правилами канала. session_enc наружу сервера не выходит. */

const { channelAccessSql } = require('../db/access');

const ISO = `'YYYY-MM-DD"T"HH24:MI:SSOF'`;

function createMentionNotifyRepo({ pool, enabled }) {
  // ── Привязка бота (deep-link /start) ────────────────────────────────────────────────────────────
  // Новая ссылка всегда РОТИРУЕТ токен (и срок), не трогая уже привязанный chat_id: перепривязка
  // безопасна — старый чат работает, пока новый /start не перепишет его.
  async function issueMentionNotifyLink(uid, tokenHash, ttlMinutes = 15) {
    if (!enabled || !uid || !tokenHash) return false;
    await pool.query(
      `INSERT INTO tg_notify_bindings (uid, link_token_hash, link_expires_at, updated_at)
       VALUES ($1, $2, now() + make_interval(mins => $3), now())
       ON CONFLICT (uid) DO UPDATE SET
         link_token_hash = EXCLUDED.link_token_hash,
         link_expires_at = EXCLUDED.link_expires_at,
         updated_at      = now()`,
      [uid, tokenHash, ttlMinutes]);
    return true;
  }

  // Вебхук: /start <token> → одна атомарная привязка. Возвращает uid или null (неверный/
  // просроченный токен). Токен одноразовый: хеш очищается в том же UPDATE.
  async function bindMentionNotifyByToken(tokenHash, { chat_id, tg_user_id, username }) {
    if (!enabled || !tokenHash || chat_id == null) return null;
    const { rows } = await pool.query(
      `UPDATE tg_notify_bindings SET
         chat_id = $2, tg_user_id = $3, username = $4,
         bound_at = now(), link_token_hash = NULL, link_expires_at = NULL, updated_at = now()
       WHERE link_token_hash = $1 AND link_expires_at > now()
       RETURNING uid`,
      [tokenHash, chat_id, tg_user_id || null, username || null]);
    return rows[0] ? rows[0].uid : null;
  }

  async function getMentionNotifyBinding(uid) {
    if (!enabled || !uid) return null;
    const { rows } = await pool.query(
      `SELECT uid, chat_id, username,
              to_char(bound_at,${ISO}) AS bound_at
         FROM tg_notify_bindings WHERE uid = $1`, [uid]);
    return rows[0] || null;
  }

  async function deleteMentionNotifyBinding(uid) {
    if (!enabled || !uid) return false;
    const { rowCount } = await pool.query('DELETE FROM tg_notify_bindings WHERE uid=$1', [uid]);
    return rowCount > 0;
  }

  // Пользователь заблокировал бота / удалил чат (403 при отправке, my_chat_member: kicked).
  // Сносим привязку целиком: повторная — тем же deep-link флоу.
  async function unbindMentionNotifyChat(chatId) {
    if (!enabled || chatId == null) return false;
    const { rowCount } = await pool.query('DELETE FROM tg_notify_bindings WHERE chat_id=$1', [chatId]);
    return rowCount > 0;
  }

  // ── Личные подписки ─────────────────────────────────────────────────────────────────────────────
  // Upsert с ВШИТЫМ доступом: INSERT…SELECT из channels под channelAccessSql — актор без доступа к
  // каналу не создаст строку (RETURNING пуст → null → роут отвечает 403), даже если route-гейт
  // забыт/обойдён (defense in depth, как в mentionSettingsRepo).
  // schedule (опц.): { send_days: smallint[] (ISO 1..7, [] = каждый день), send_hour: 0..23 МСК } —
  // валидация в роуте; отсутствие ключа сохраняет прежнее значение (COALESCE на UPDATE-ветке).
  async function setMentionNotifySubscriptionForActor(channelId, actor, enabledFlag, schedule = {}) {
    if (!enabled || !channelId) return null;
    const uid = actor && actor.uid;
    if (uid == null) return null;
    const days = Array.isArray(schedule.send_days) ? schedule.send_days : null;
    const hour = Number.isInteger(schedule.send_hour) ? schedule.send_hour : null;
    const { rows } = await pool.query(
      `INSERT INTO mention_notify_subscriptions (channel_id, uid, enabled, send_days, send_hour, created_at, updated_at)
       SELECT c.id, $2, $3, COALESCE($4::smallint[], '{}'), COALESCE($5::smallint, 10), now(), now()
         FROM channels c
        WHERE c.id = $1 AND c.status <> 'disabled'
          AND ${channelAccessSql({ channelAlias: 'c', uidParam: '$2' })}
       ON CONFLICT (channel_id, uid) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         send_days = COALESCE($4::smallint[], mention_notify_subscriptions.send_days),
         send_hour = COALESCE($5::smallint, mention_notify_subscriptions.send_hour),
         updated_at = now()
       RETURNING channel_id, uid, enabled, send_days, send_hour,
                 to_char(last_run_at,${ISO})      AS last_run_at,
                 to_char(last_notified_at,${ISO}) AS last_notified_at,
                 last_error`,
      [channelId, uid, !!enabledFlag, days, hour]);
    return rows[0] || null;
  }

  async function getMentionNotifySubscription(channelId, uid) {
    if (!enabled || !channelId || !uid) return null;
    const { rows } = await pool.query(
      `SELECT channel_id, uid, enabled, send_days, send_hour,
              to_char(last_run_at,${ISO})      AS last_run_at,
              to_char(last_notified_at,${ISO}) AS last_notified_at,
              last_error
         FROM mention_notify_subscriptions WHERE channel_id=$1 AND uid=$2`,
      [channelId, uid]);
    return rows[0] || null;
  }

  // Cron-ридер: всё, что реально можно прогнать сегодня. Правила (include_terms) и канал берутся
  // здесь же, чтобы джоб не делал N дополнительных запросов; session_enc расшифровывает ТОЛЬКО джоб.
  const RUNNABLE_SQL = `
    SELECT s.channel_id, s.uid, s.send_days, s.send_hour,
           to_char(s.last_notified_at,${ISO}) AS last_notified_at,
           b.chat_id,
           c.title AS channel_title, c.username AS channel_username, c.tg_channel_id,
           m.include_terms, m.exclude_terms, m.exclude_sources, m.match_mode,
           t.session_enc, t.session_version, t.connection_state
      FROM mention_notify_subscriptions s
      JOIN tg_notify_bindings b ON b.uid = s.uid AND b.chat_id IS NOT NULL
      JOIN channels c           ON c.id = s.channel_id AND c.status <> 'disabled'
      JOIN channel_mention_settings m
           ON m.channel_id = s.channel_id AND cardinality(m.include_terms) > 0
      JOIN tg_sessions t        ON t.uid = s.uid AND t.connection_state <> 'reauth_required'
     WHERE s.enabled`;

  async function listRunnableMentionNotifySubscriptions() {
    if (!enabled) return [];
    const { rows } = await pool.query(`${RUNNABLE_SQL} ORDER BY s.channel_id, s.uid`);
    return rows;
  }

  // Точечный вариант для тест-прогона «Прислать сейчас»: та же строка с теми же JOIN-условиями
  // (binding+rules+живая сессия+enabled) — null означает «прогнать нечего», роут отвечает 409.
  async function getRunnableMentionNotifySubscription(channelId, uid) {
    if (!enabled || !channelId || !uid) return null;
    const { rows } = await pool.query(
      `${RUNNABLE_SQL} AND s.channel_id = $1 AND s.uid = $2`, [channelId, uid]);
    return rows[0] || null;
  }

  // Штамп прогона. notified=true двигает watermark доставки (seed или реальные карточки);
  // errorCode — только безопасный код из allow-list джоба, NULL затирает прошлую ошибку.
  async function markMentionNotifyRun(channelId, uid, { notified = false, errorCode = null } = {}) {
    if (!enabled || !channelId || !uid) return false;
    const { rowCount } = await pool.query(
      `UPDATE mention_notify_subscriptions SET
         last_run_at = now(),
         last_notified_at = CASE WHEN $3 THEN now() ELSE last_notified_at END,
         last_error = $4,
         updated_at = now()
       WHERE channel_id=$1 AND uid=$2`,
      [channelId, uid, !!notified, errorCode]);
    return rowCount > 0;
  }

  // Какие из найденных упоминаний ЕЩЁ НЕ в архиве канала — их и доставляем. Сверка по ключу
  // архива (owner_channel_id, channel_id, msg_id); сам архив пишет collectorRepo.upsertMentions.
  async function filterNewMentions(ownerChannelId, list) {
    if (!enabled || !ownerChannelId || !Array.isArray(list) || !list.length) return [];
    const clean = list.filter((m) => m && m.channel_id != null && m.msg_id != null);
    if (!clean.length) return [];
    const { rows } = await pool.query(
      `SELECT x.channel_id, x.msg_id
         FROM jsonb_to_recordset($2::jsonb) AS x(channel_id bigint, msg_id bigint)
        WHERE NOT EXISTS (
          SELECT 1 FROM mentions m
           WHERE m.owner_channel_id = $1 AND m.channel_id = x.channel_id AND m.msg_id = x.msg_id)`,
      [ownerChannelId, JSON.stringify(clean.map((m) => ({ channel_id: m.channel_id, msg_id: m.msg_id })))]);
    const fresh = new Set(rows.map((r) => `${r.channel_id}:${r.msg_id}`));
    return clean.filter((m) => fresh.has(`${m.channel_id}:${m.msg_id}`));
  }

  return {
    issueMentionNotifyLink,
    bindMentionNotifyByToken,
    getMentionNotifyBinding,
    deleteMentionNotifyBinding,
    unbindMentionNotifyChat,
    setMentionNotifySubscriptionForActor,
    getMentionNotifySubscription,
    listRunnableMentionNotifySubscriptions,
    getRunnableMentionNotifySubscription,
    markMentionNotifyRun,
    filterNewMentions,
  };
}

module.exports = { createMentionNotifyRepo };
