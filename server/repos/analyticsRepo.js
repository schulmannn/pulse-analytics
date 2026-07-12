'use strict';

/* ── Analytics reads repo (P2 db-split, PR 6) ────────────────────────────────────────────────────
   Read-модели для графиков/панелей: история дневных метрик канала (canonical source-union),
   упоминания (сводка + архив-панель), снапшот, свежая velocity, IG daily/media история. Извлечено
   ДОСЛОВНО из db.js — SQL не менялся. Публичный `db.*` API не меняется: db.js спредит методы репо.

   Зависит от pool + enabled (инъекция) + sameTenantSource из ../db/access (leaf): canonical-ридеры
   (getChannelHistory/getLatestVelocity) union'ят строки по source_id, ограничивая объединение
   воркспейсом читателя (ADR-001 F1). Без импортов db.js/других repo.

   ⚠️ КОНТРАКТ ДОСТУПА (finding 5, СЛЕДУЮЩИЙ PR 6.5): сейчас ридеры принимают голый channelId и
   доверяют route-авторизации (routes зовут их с уже resolved `req.channel.id` — makeResolveChannel
   сделал ownership-check и вернул 403 иначе). Репо это НЕ форсит: новый эндпоинт, забывший
   resolveChannel, прочитал бы чужое. План 6.5 — развести `getXForActor(channelId, actor)` (встраивает
   access-предикат в query) и `getXInternal(channelId)` (только cron/service), отдельным diff'ом с
   route-флипами и access-denial тестами (дисциплина «не менять SQL и структуру одновременно»). */

const { sameTenantSource } = require('../db/access');

function createAnalyticsRepo({ pool, enabled }) {
  async function getChannelHistory(channelId, days = 400) {
    if (!enabled || !channelId) return [];
    // Canonical read (ADR-001 phase B): the history of the channel's SOURCE — a same-workspace
    // co-follow of one @channel sees ONE row-set. Until phase C flips the write conflict-targets, both
    // links may still write their own rows, so DISTINCT ON (day) keeps the freshest capture. The
    // source union is bounded to the reader's own workspace (sameTenantSource) so an unverified
    // source claim can't inherit another tenant's history; links without a source fall back to their
    // own channel-scoped rows.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (d.day)
              to_char(d.day,'YYYY-MM-DD') AS day, d.subscribers, d.joins, d.leaves, d.views, d.forwards, d.reactions
       FROM channel_daily d
       JOIN channels c ON c.id = $1
       WHERE ((c.source_id IS NOT NULL AND d.source_id = c.source_id AND ${sameTenantSource('d', 'c')})
              OR d.channel_id = c.id)
         AND d.day >= (CURRENT_DATE - $2::int)
       ORDER BY d.day ASC, d.captured_at DESC NULLS LAST`, [channelId, days]);
    return rows;
  }

  async function getMentionsHistory(channelId) {
    if (!enabled || !channelId) return null;
    const total = await pool.query(
      'SELECT count(*)::int AS total, count(distinct channel_id)::int AS channels, COALESCE(sum(views),0)::bigint AS views FROM mentions WHERE owner_channel_id=$1', [channelId]);
    const byMonth = await pool.query(
      `SELECT to_char(date_trunc('month', COALESCE(post_date, first_seen)),'YYYY-MM') AS month, count(*)::int AS c
       FROM mentions WHERE owner_channel_id=$1 GROUP BY 1 ORDER BY 1`, [channelId]);
    return { total: total.rows[0], by_month: byMonth.rows };
  }

  // Full mentions panel from the archive — same shape renderMentions() expects from
  // the live search, so the dashboard can show stored mentions without spending quota.
  async function getMentionsArchive(channelId, limit = 30) {
    if (!enabled || !channelId) return null;
    const totals = await pool.query(
      `SELECT count(*)::int AS total, count(distinct channel_id)::int AS unique_channels,
              COALESCE(sum(views),0)::bigint AS total_views FROM mentions WHERE owner_channel_id=$1`, [channelId]);
    const byDay = await pool.query(
      `SELECT to_char(COALESCE(post_date, first_seen),'DD.MM') AS d, count(*)::int AS c
         FROM mentions WHERE owner_channel_id=$1 AND COALESCE(post_date, first_seen) >= (CURRENT_DATE - 60) GROUP BY 1`, [channelId]);
    const channels = await pool.query(
      `SELECT max(title) AS title, max(username) AS username, count(*)::int AS count,
              COALESCE(sum(views),0)::bigint AS views
         FROM mentions WHERE owner_channel_id=$1 GROUP BY channel_id ORDER BY count(*) DESC, sum(views) DESC NULLS LAST LIMIT 10`, [channelId]);
    const recent = await pool.query(
      `SELECT channel_id, msg_id, title, username, link, snippet, views,
              to_char(COALESCE(post_date, first_seen),'YYYY-MM-DD"T"HH24:MI:SS') AS date
         FROM mentions WHERE owner_channel_id=$1 ORDER BY COALESCE(post_date, first_seen) DESC LIMIT $2`, [channelId, limit]);
    const t = totals.rows[0] || {};
    const by_day = {};
    for (const r of byDay.rows) by_day[r.d] = r.c;
    return {
      available: true,
      total: t.total || 0,
      unique_channels: t.unique_channels || 0,
      total_views: Number(t.total_views || 0),
      by_day,
      // pg отдаёт bigint строкой — приводим к number (сумма просмотров << 2^53, точность не страдает;
      // строка ломала бы zod-схему фронта и арифметику сортировок). ::int здесь переполнялся.
      top_channels: channels.rows.map((r) => ({ ...r, views: Number(r.views || 0) })),
      recent: recent.rows,
    };
  }

  async function getSnapshot(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT data, to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
         FROM channel_snapshots WHERE channel_id=$1`, [channelId]);
    return rows[0] || null;   // { data, updated_at } | null
  }

  async function getLatestVelocity(channelId) {
    if (!enabled || !channelId) return null;
    // Canonical read (ADR-001): freshest snapshot of the channel's source (bounded to the reader's
    // own workspace via sameTenantSource so an unverified source claim can't read a foreign tenant's
    // velocity), own rows as fallback.
    const { rows } = await pool.query(
      `SELECT v.data, to_char(v.computed_at,'YYYY-MM-DD"T"HH24:MI:SS') AS computed_at
         FROM velocity_daily v
         JOIN channels c ON c.id = $1
        WHERE ((c.source_id IS NOT NULL AND v.source_id = c.source_id AND ${sameTenantSource('v', 'c')})
               OR v.channel_id = c.id)
        ORDER BY v.day DESC, v.computed_at DESC NULLS LAST LIMIT 1`, [channelId]);
    return rows[0] || null;   // { data, computed_at } | null
  }

  // ── Read helpers (история для будущих графиков) ──
  async function listIgDaily(channelId, days = 400) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, followers, followers_total, reach, views, profile_views,
              accounts_engaged, total_interactions, likes, comments, saves, shares, follows, unfollows
         FROM ig_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int) ORDER BY day ASC`,
      [channelId, days]);
    return rows;
  }

  async function listIgMediaDaily(channelId, days = 400) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT media_id, to_char(day,'YYYY-MM-DD') AS day, reach, likes, comments, saved, shares, views
         FROM ig_media_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int)
         ORDER BY media_id ASC, day ASC`, [channelId, days]);
    return rows;
  }

  return {
    getChannelHistory, getMentionsHistory, getMentionsArchive,
    getSnapshot, getLatestVelocity,
    listIgDaily, listIgMediaDaily,
  };
}

module.exports = { createAnalyticsRepo };
