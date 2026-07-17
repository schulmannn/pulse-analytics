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
const { parseMentionsRange, rangeDayCount } = require('../lib/mentionsRange');
const { toMetricNumber } = require('../lib/metricNumber');

// Metric counter columns are BIGINT (migration 023); node-postgres returns BIGINT as a decimal
// STRING. Convert exactly the widened counters back to JS numbers (safe within MAX_SAFE_METRIC) so
// the API contract keeps emitting numbers; identifiers (post_id, mention channel_id/msg_id) stay
// strings and are handled separately.
const CHANNEL_DAILY_METRICS = ['subscribers', 'joins', 'leaves', 'views', 'forwards', 'reactions'];
const POST_METRICS = ['views', 'reactions', 'forwards', 'replies'];
const IG_DAILY_METRICS = ['followers', 'followers_total', 'reach', 'views', 'profile_views',
  'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'follows', 'unfollows'];
const IG_MEDIA_METRICS = ['reach', 'likes', 'comments', 'saved', 'shares', 'views'];
// Копеечные суммы ms_daily — BIGINT (pg отдаёт строкой); orders_count — INTEGER (уже number,
// numify — no-op-страховка). Бюджет toMetricNumber (9e15) = 90 трлн ₽ — за глаза.
const MS_DAILY_METRICS = ['revenue_kopecks', 'orders_count', 'orders_sum_kopecks'];
const IG_TAG_METRICS = ['like_count', 'comments_count'];
const numifyMetrics = (row, keys) => {
  const out = { ...row };
  for (const k of keys) out[k] = toMetricNumber(out[k]);
  return out;
};

/** Positive-bigint mentioning-channel id (as a string for pg bigint params), or null on garbage. */
function normalizeSourceId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = s.replace(/^0+(?=\d)/, '');
  return n === '0' ? null : n;
}

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
    return rows.map((r) => numifyMetrics(r, CHANNEL_DAILY_METRICS));
  }

  async function getMentionsHistoryInternal(channelId) {
    if (!enabled || !channelId) return null;
    const total = await pool.query(
      'SELECT count(*)::int AS total, count(distinct channel_id)::int AS channels, COALESCE(sum(views),0)::bigint AS views FROM mentions WHERE owner_channel_id=$1', [channelId]);
    const byMonth = await pool.query(
      `SELECT to_char(date_trunc('month', COALESCE(post_date, first_seen)),'YYYY-MM') AS month, count(*)::int AS c
       FROM mentions WHERE owner_channel_id=$1 GROUP BY 1 ORDER BY 1`, [channelId]);
    return {
      total: total.rows[0] ? { ...total.rows[0], views: toMetricNumber(total.rows[0].views) } : null,
      by_month: byMonth.rows,
    };
  }

  // Full mentions panel from the archive — same shape renderMentions() expects from the live
  // search, so the dashboard can show stored mentions without spending quota. Extended (desktop
  // Упоминания redesign) with honest period scope: opts = { days, source, limit }.
  //   • days ∈ {0,7,30,90}. 0 = legacy/mobile/Home (весь архив, by_day за 60 дн). 7/30/90 = current
  //     календарное окно, включая сегодня (>= CURRENT_DATE-(days-1) и < завтра), плюс previous —
  //     непосредственно предшествующее равное окно для сравнения.
  //   • source — необязательный positive-bigint channel_id упомянувшего внешнего канала; фильтрует
  //     ТОЛЬКО строки внутри owner_channel_id. source_options считается ДО применения фильтра.
  //   • limit — clamp 1..100 (default 30) для recent.
  // Backwards-compat: числовой второй аргумент трактуется как legacy `limit` (days=0).
  async function getMentionsArchiveInternal(channelId, opts = {}) {
    if (!enabled || !channelId) return null;
    if (typeof opts === 'number') opts = { limit: opts };
    const limit = Math.min(100, Math.max(1, Number.parseInt(opts.limit, 10) || 30));
    const daysRaw = Number(opts.days);
    const days = daysRaw === 7 || daysRaw === 30 || daysRaw === 90 ? daysRaw : 0;
    const source = normalizeSourceId(opts.source);
    // Свой диапазон (from/to, включительно) приоритетнее days-пресета. Ре-валидируем даже то, что
    // передал роут (репо не доверяет вызывающему): в SQL уходят ТОЛЬКО строки строгого YYYY-MM-DD,
    // поэтому date-литералы безопасны — та же дисциплина, что у whitelisted-смещений {7,30,90}.
    const range = parseMentionsRange(opts.range);
    // «Оконный» режим = есть диапазон ЛИБО days-пресет. Диапазон всегда сравним (есть предыдущее окно).
    const windowed = range != null || days !== 0;

    const dayExpr = 'COALESCE(post_date, first_seen)';
    // Календарные окна. Литеральные смещения безопасны: days из белого списка {7,30,90}, а границы
    // диапазона — строгий YYYY-MM-DD. Для диапазона предыдущее окно — равной длины, сразу перед from.
    let curBounds;
    let prevBounds;
    if (range) {
      const f = `'${range.from}'::date`;
      const t = `'${range.to}'::date`;
      const len = `((${t} - ${f}) + 1)`;
      curBounds = `${dayExpr} >= ${f} AND ${dayExpr} < ${t} + 1`;
      prevBounds = `${dayExpr} >= ${f} - ${len} AND ${dayExpr} < ${f}`;
    } else if (days !== 0) {
      curBounds = `${dayExpr} >= CURRENT_DATE - ${days - 1} AND ${dayExpr} < CURRENT_DATE + 1`;
      prevBounds = `${dayExpr} >= CURRENT_DATE - ${2 * days - 1} AND ${dayExpr} < CURRENT_DATE - ${days - 1}`;
    } else {
      curBounds = null;
      prevBounds = null;
    }

    // scope: owner (+ optional source) (+ optional date bounds). Возвращает clause + params с $1=channelId.
    const scope = (bounds) => {
      const params = [channelId];
      let clause = 'owner_channel_id = $1';
      if (source != null) { params.push(source); clause += ` AND channel_id = $${params.length}`; }
      if (bounds) clause += ` AND ${bounds}`;
      return { clause, params };
    };

    const cur = scope(curBounds);
    const totals = await pool.query(
      `SELECT count(*)::int AS total, count(distinct channel_id)::int AS unique_channels,
              COALESCE(sum(views),0)::bigint AS total_views FROM mentions WHERE ${cur.clause}`, cur.params);
    // by_day (legacy DD.MM): для days=0 — прежние 60 дней; для окна — окно (десктоп его не читает).
    const byDayScope = scope(curBounds ?? `${dayExpr} >= CURRENT_DATE - 60`);
    const byDay = await pool.query(
      `SELECT to_char(${dayExpr},'DD.MM') AS d, count(*)::int AS c
         FROM mentions WHERE ${byDayScope.clause} GROUP BY 1`, byDayScope.params);
    const channels = await pool.query(
      `SELECT max(title) AS title, max(username) AS username, count(*)::int AS count,
              COALESCE(sum(views),0)::bigint AS views
         FROM mentions WHERE ${cur.clause} GROUP BY channel_id ORDER BY count(*) DESC, sum(views) DESC NULLS LAST LIMIT 10`,
      cur.params);
    const recentParams = [...cur.params, limit];
    const recent = await pool.query(
      `SELECT channel_id, msg_id, title, username, link, snippet, views,
              to_char(COALESCE(post_date, first_seen),'YYYY-MM-DD"T"HH24:MI:SS') AS date
         FROM mentions WHERE ${cur.clause} ORDER BY COALESCE(post_date, first_seen) DESC LIMIT $${recentParams.length}`,
      recentParams);
    // ISO daily для текущего scope. Для окна — сервер отдаёт присутствующие дни; нулевые
    // календарные дни дозаполняет фронт. Для all-time ограничиваем последними 365 дн (честная
    // граница вместо гигантской искусственной серии).
    const dailyScope = scope(curBounds ?? `${dayExpr} >= CURRENT_DATE - 364`);
    const daily = await pool.query(
      `SELECT to_char(${dayExpr}::date,'YYYY-MM-DD') AS day, count(*)::int AS mentions,
              COALESCE(sum(views),0)::bigint AS views, count(distinct channel_id)::int AS channels
         FROM mentions WHERE ${dailyScope.clause} GROUP BY 1 ORDER BY 1`, dailyScope.params);
    // source_options за текущий период ДО source-фильтра — лидерборд/фильтр не исчезает при выборе.
    const soParams = [channelId];
    const soClause = 'owner_channel_id = $1' + (curBounds ? ` AND ${curBounds}` : '');
    const sourceOpts = await pool.query(
      `SELECT channel_id, max(title) AS title, max(username) AS username, count(*)::int AS count,
              COALESCE(sum(views),0)::bigint AS views,
              sum(count(*)) OVER ()::int AS period_total,
              COALESCE(sum(sum(views)) OVER (),0)::bigint AS period_views,
              count(*) OVER ()::int AS period_channels
         FROM mentions WHERE ${soClause} GROUP BY channel_id ORDER BY count(*) DESC, sum(views) DESC NULLS LAST LIMIT 25`,
      soParams);
    // Границы текущего/предыдущего окна (текстом YYYY-MM-DD). Для диапазона current_* = сами from/to,
    // а current_to (якорь дневного графика на фронте) — именно `to`, а не CURRENT_DATE.
    let currentFromExpr;
    let currentToExpr;
    let previousFromExpr;
    let previousToExpr;
    if (range) {
      const f = `'${range.from}'::date`;
      const t = `'${range.to}'::date`;
      const len = `((${t} - ${f}) + 1)`;
      currentFromExpr = `'${range.from}'::text`;
      currentToExpr = `'${range.to}'::text`;
      previousFromExpr = `to_char(${f} - ${len},'YYYY-MM-DD')`;
      previousToExpr = `to_char(${f} - 1,'YYYY-MM-DD')`;
    } else if (days !== 0) {
      currentFromExpr = `to_char(CURRENT_DATE - ${days - 1},'YYYY-MM-DD')`;
      currentToExpr = `to_char(CURRENT_DATE,'YYYY-MM-DD')`;
      previousFromExpr = `to_char(CURRENT_DATE - ${2 * days - 1},'YYYY-MM-DD')`;
      previousToExpr = `to_char(CURRENT_DATE - ${days},'YYYY-MM-DD')`;
    } else {
      currentFromExpr = 'NULL::text';
      currentToExpr = `to_char(CURRENT_DATE,'YYYY-MM-DD')`;
      previousFromExpr = 'NULL::text';
      previousToExpr = 'NULL::text';
    }
    // Свежесть + all-time count (без scope и source).
    const meta = await pool.query(
      `SELECT count(*)::int AS archive_total,
              to_char(max(last_seen),'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at,
              to_char(max(${dayExpr}),'YYYY-MM-DD"T"HH24:MI:SS') AS latest_seen,
              ${currentToExpr} AS current_to,
              ${currentFromExpr} AS current_from,
              ${previousFromExpr} AS previous_from,
              ${previousToExpr} AS previous_to
         FROM mentions WHERE owner_channel_id=$1`, [channelId]);

    let previous = null;
    let previous_daily = [];
    if (windowed) {
      const prev = scope(prevBounds);
      const pt = (await pool.query(
        `SELECT count(*)::int AS total, count(distinct channel_id)::int AS unique_channels,
                COALESCE(sum(views),0)::bigint AS total_views FROM mentions WHERE ${prev.clause}`, prev.params)).rows[0] || {};
      previous = {
        total: pt.total || 0,
        unique_channels: pt.unique_channels || 0,
        total_views: toMetricNumber(pt.total_views || 0),
      };
      previous_daily = (await pool.query(
        `SELECT to_char(${dayExpr}::date,'YYYY-MM-DD') AS day, count(*)::int AS mentions,
                COALESCE(sum(views),0)::bigint AS views, count(distinct channel_id)::int AS channels
           FROM mentions WHERE ${prev.clause} GROUP BY 1 ORDER BY 1`, prev.params)).rows
        .map((r) => ({ day: r.day, mentions: r.mentions, views: toMetricNumber(r.views || 0), channels: r.channels }));
    }

    const t = totals.rows[0] || {};
    const m = meta.rows[0] || {};
    const by_day = {};
    for (const r of byDay.rows) by_day[r.d] = r.c;
    return {
      available: true,
      total: t.total || 0,
      unique_channels: t.unique_channels || 0,
      total_views: toMetricNumber(t.total_views || 0),
      by_day,
      // pg отдаёт bigint строкой — приводим к number (сумма просмотров << 2^53, точность не страдает;
      // строка ломала бы zod-схему фронта и арифметику сортировок). ::int здесь переполнялся.
      top_channels: channels.rows.map((r) => ({ ...r, views: toMetricNumber(r.views || 0) })),
      // channel_id (TG peer id) — идентификатор для клик-фильтра источника: держим строкой (bigint).
      // views — BIGINT-счётчик (023): pg отдаёт строкой, приводим к числу в границах MAX_SAFE_METRIC.
      recent: recent.rows.map((r) => ({
        ...r,
        channel_id: r.channel_id != null ? String(r.channel_id) : null,
        views: toMetricNumber(r.views),
      })),
      daily: daily.rows.map((r) => ({ day: r.day, mentions: r.mentions, views: toMetricNumber(r.views || 0), channels: r.channels })),
      previous,
      previous_daily,
      source_options: sourceOpts.rows.map((r) => ({
        channel_id: r.channel_id != null ? String(r.channel_id) : null,
        title: r.title,
        username: r.username,
        count: r.count,
        views: toMetricNumber(r.views || 0),
      })),
      source_summary: {
        total: sourceOpts.rows[0]?.period_total || 0,
        unique_channels: sourceOpts.rows[0]?.period_channels || 0,
        total_views: toMetricNumber(sourceOpts.rows[0]?.period_views || 0),
      },
      scope: {
        // days=0 при своём диапазоне: фронт различает окно по from/to, а не по days-пресету.
        days: range ? 0 : days,
        source: source != null ? String(source) : null,
        from: range ? range.from : null,
        to: range ? range.to : null,
        limit,
        current_from: m.current_from || null,
        current_to: m.current_to || null,
        previous_from: m.previous_from || null,
        previous_to: m.previous_to || null,
        daily_days: range ? rangeDayCount(range) : days === 0 ? 365 : days,
      },
      archive_total: m.archive_total || 0,
      latest_seen: m.latest_seen || null,
      updated_at: m.updated_at || null,
    };
  }

  async function getSnapshotInternal(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT data, to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
         FROM channel_snapshots WHERE channel_id=$1`, [channelId]);
    return rows[0] || null;   // { data, updated_at } | null
  }

  // Narrow public-media reader for the open Telegram avatar route. It deliberately exposes only the
  // bounded base64 transport field, never the rest of the internal dashboard snapshot. The route
  // resolves the canonical central channel id and re-validates the JPEG bytes before serving them.
  async function getPublicTgChannelPhoto(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT data->>'channel_photo' AS channel_photo
         FROM channel_snapshots WHERE channel_id=$1`, [channelId]);
    return rows[0]?.channel_photo || null;
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
    // id (post_id) is a BIGINT identifier — leave it as pg returned it; only the counters are numified.
    return rows.map((r) => numifyMetrics(r, POST_METRICS));
  }

  // ── Read helpers (история для будущих графиков) ──
  async function listIgDailyInternal(channelId, days = 400) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, followers, followers_total, reach, views, profile_views,
              accounts_engaged, total_interactions, likes, comments, saves, shares, follows, unfollows
         FROM ig_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int) ORDER BY day ASC`,
      [channelId, days]);
    return rows.map((r) => numifyMetrics(r, IG_DAILY_METRICS));
  }

  async function listIgMediaDailyInternal(channelId, days = 400) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT media_id, to_char(day,'YYYY-MM-DD') AS day, reach, likes, comments, saved, shares, views
         FROM ig_media_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int)
         ORDER BY media_id ASC, day ASC`, [channelId, days]);
    // media_id stays a TEXT identifier; only the BIGINT counters are numified.
    return rows.map((r) => numifyMetrics(r, IG_MEDIA_METRICS));
  }

  // Весь дневной архив МойСклада канала («Всё» в summary), day ASC. Без окна — глубина архива
  // ограничена самим кроном (растёт день за днём), а не читателем; суммы отдаются в КОПЕЙКАХ
  // (как лежат в БД) — в рубли конвертирует граница API (kopecksToRub), не repo.
  async function getMsDailyAllInternal(channelId) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, revenue_kopecks, orders_count, orders_sum_kopecks
         FROM ms_daily WHERE channel_id=$1 ORDER BY day ASC`, [channelId]);
    return rows.map((r) => numifyMetrics(r, MS_DAILY_METRICS));
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
  async function getMentionsArchiveForActor(channelId, actor, opts = 30) {
    return (await allowed(channelId, actor)) ? getMentionsArchiveInternal(channelId, opts) : null;
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
  async function getMsDailyAllForActor(channelId, actor) {
    return (await allowed(channelId, actor)) ? getMsDailyAllInternal(channelId) : [];
  }

    // ── ig-tags read (finding 7: чтение — analytics, write — collectorRepo) ──
  async function getIgTags(limit = 100) {
    if (!enabled) return [];
    const { rows } = await pool.query(
      `SELECT media_id AS id, username, caption, permalink, media_type, like_count, comments_count,
              to_char(posted_at,'YYYY-MM-DD"T"HH24:MI:SS') AS timestamp,
              to_char(first_seen,'YYYY-MM-DD"T"HH24:MI:SS') AS first_seen
       FROM ig_tags ORDER BY posted_at DESC NULLS LAST, first_seen DESC LIMIT $1`, [limit]);
    return rows.map((r) => numifyMetrics(r, IG_TAG_METRICS));
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
    getSnapshotInternal, getPublicTgChannelPhoto,
    getLatestVelocityInternal, listPostsInternal, listIgDailyInternal, listIgMediaDailyInternal,
    getMsDailyAllInternal,
    getChannelHistoryForActor, getMentionsHistoryForActor, getMentionsArchiveForActor,
    getSnapshotForActor, getLatestVelocityForActor, listPostsForActor, listIgDailyForActor, listIgMediaDailyForActor,
    getMsDailyAllForActor,
  };
}

module.exports = { createAnalyticsRepo };
