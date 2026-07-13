'use strict';

/* ── Analytics reads repo (P2 db-split, PR 6 + finding 5 контракт доступа) ────────────────────────
   Read-модели для графиков/панелей: история дневных метрик канала (canonical source-union),
   упоминания (сводка + архив-панель), снапшот, свежая velocity, IG daily/media история. SQL не
   менялся с момента выноса (PR 6) — здесь добавлен только явный контракт доступа (finding 5).

   КОНТРАКТ ДОСТУПА (finding 5): у каждого канал-скоупного ридера ДВА варианта, чтобы намерение
   вызывающего было в самом имени, а не «route должен помнить»:
     • `<name>ForActor(channelId, actor, …)` — сначала проверяет доступ актора к каналу
       (getAccessibleChannel — инъекция channelsRepo.getChannel, вернёт null без доступа), иначе
       отдаёт ПУСТО ([]/null). Это путь для роут-хендлеров: даже забыв про resolve-middleware,
       эндпоинт не утечёт чужие данные.
     • `<name>Internal(channelId, …)` — БЕЗ проверки, только для cron/service-кода, который сам
       установил доступ (напр. processReportSchedules сверил членство через listChannels).
   Голого un-gated ридера в публичном API больше НЕТ — выбор Internal/ForActor всегда осознанный.

   Зависит от pool + enabled + sameTenantSource из ../db/access (canonical union ограничен
   воркспейсом читателя, ADR-001 F1) + getAccessibleChannel (инъекция; repos не импортят друг друга). */

const { sameTenantSource, channelAccessSql } = require('../db/access');

function createAnalyticsRepo({ pool, enabled, getAccessibleChannel }) {
  // ── Internal reads (БЕЗ access-check — ТОЛЬКО cron/service) ─────────────────────────────────────
  async function getChannelHistoryInternal(channelId, days = 400) {
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

  async function getMentionsHistoryInternal(channelId) {
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
  async function getMentionsArchiveInternal(channelId, limit = 30) {
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

  async function getSnapshotInternal(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT data, to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
         FROM channel_snapshots WHERE channel_id=$1`, [channelId]);
    return rows[0] || null;   // { data, updated_at } | null
  }

  async function getLatestVelocityInternal(channelId) {
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

  async function listPostsInternal(channelId, limit = 100) {
    if (!enabled || !channelId) return [];
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
    // The request path reads the normalized archive instead of waiting on Telethon. As with
    // history/velocity, co-followed links may share rows only inside the reader's tenant.
    const { rows } = await pool.query(
      `SELECT id, date, text, views, reactions, forwards, replies, media_type, hashtags
         FROM (
           SELECT DISTINCT ON (p.post_id)
                  p.post_id AS id, p.date_published AS date, p.caption AS text,
                  p.views, p.reactions, p.forwards, p.replies, p.media_type, p.hashtags,
                  p.updated_at
             FROM posts p
             JOIN channels c ON c.id = $1
            WHERE ((c.source_id IS NOT NULL AND p.source_id = c.source_id AND ${sameTenantSource('p', 'c')})
                   OR p.channel_id = c.id)
            ORDER BY p.post_id, p.updated_at DESC NULLS LAST
         ) latest
        ORDER BY date DESC NULLS LAST, id DESC
        LIMIT $2`, [channelId, safeLimit]);
    return rows;
  }

  // ── Read helpers (история для будущих графиков) ──
  async function listIgDailyInternal(channelId, days = 400) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, followers, followers_total, reach, views, profile_views,
              accounts_engaged, total_interactions, likes, comments, saves, shares, follows, unfollows
         FROM ig_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int) ORDER BY day ASC`,
      [channelId, days]);
    return rows;
  }

  async function listIgMediaDailyInternal(channelId, days = 400) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT media_id, to_char(day,'YYYY-MM-DD') AS day, reach, likes, comments, saved, shares, views
         FROM ig_media_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int)
         ORDER BY media_id ASC, day ASC`, [channelId, days]);
    return rows;
  }

  // ── Actor-gated reads: сначала проверяем доступ, иначе пусто (ПУТЬ ДЛЯ РОУТОВ) ──────────────────
  // null-доступ → пустой результат того же типа, что у Internal (список → [], одиночка → null).
  const allowed = (channelId, actor) => getAccessibleChannel(channelId, actor);

  async function getChannelHistoryForActor(channelId, actor, days = 400) {
    return (await allowed(channelId, actor)) ? getChannelHistoryInternal(channelId, days) : [];
  }
  async function getMentionsHistoryForActor(channelId, actor) {
    return (await allowed(channelId, actor)) ? getMentionsHistoryInternal(channelId) : null;
  }
  async function getMentionsArchiveForActor(channelId, actor, limit = 30) {
    return (await allowed(channelId, actor)) ? getMentionsArchiveInternal(channelId, limit) : null;
  }
  async function getSnapshotForActor(channelId, actor) {
    return (await allowed(channelId, actor)) ? getSnapshotInternal(channelId) : null;
  }
  async function getLatestVelocityForActor(channelId, actor) {
    return (await allowed(channelId, actor)) ? getLatestVelocityInternal(channelId) : null;
  }
  async function listPostsForActor(channelId, actor, limit = 100) {
    return (await allowed(channelId, actor)) ? listPostsInternal(channelId, limit) : [];
  }
  async function listIgDailyForActor(channelId, actor, days = 400) {
    return (await allowed(channelId, actor)) ? listIgDailyInternal(channelId, days) : [];
  }
  async function listIgMediaDailyForActor(channelId, actor, days = 400) {
    return (await allowed(channelId, actor)) ? listIgMediaDailyInternal(channelId, days) : [];
  }

    // ── ig-tags read (finding 7: чтение — analytics, write — collectorRepo) ──
  async function getIgTags(limit = 100) {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT media_id AS id, username, caption, permalink, media_type, like_count, comments_count,
              to_char(posted_at,'YYYY-MM-DD"T"HH24:MI:SS') AS timestamp,
              to_char(first_seen,'YYYY-MM-DD"T"HH24:MI:SS') AS first_seen
       FROM ig_tags ORDER BY posted_at DESC NULLS LAST, first_seen DESC LIMIT $1`, [limit]);
    return rows;
  }

  // ── Connection-status коллектора (read; writes живут в ingest/collectorRepo) ───────
  async function getCollectorStatus(channelId, user) {
    if (!enabled || !channelId || !user || user.uid == null) return null;
    const { rows } = await pool.query(
      `SELECT s.collector_version, s.last_ingest_id,
              to_char(s.last_attempt_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_attempt_at,
              to_char(s.last_success_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_success_at,
              s.last_error
         FROM collector_status s
         JOIN channels c ON c.id=s.channel_id
        WHERE s.channel_id=$1 AND ${channelAccessSql({ channelAlias: 'c', uidParam: '$2' })}`,
      [channelId, user.uid]);
    return rows[0] || null;
  }

  return {
    getIgTags, getCollectorStatus,
    getChannelHistoryInternal, getMentionsHistoryInternal, getMentionsArchiveInternal,
    getSnapshotInternal, getLatestVelocityInternal, listPostsInternal, listIgDailyInternal, listIgMediaDailyInternal,
    getChannelHistoryForActor, getMentionsHistoryForActor, getMentionsArchiveForActor,
    getSnapshotForActor, getLatestVelocityForActor, listPostsForActor, listIgDailyForActor, listIgMediaDailyForActor,
  };
}

module.exports = { createAnalyticsRepo };
