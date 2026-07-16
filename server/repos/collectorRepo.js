'use strict';

/* ── Collector writes repo (P2 db-split, PR 7) ───────────────────────────────────────────────────
   Приём и запись данных collector'а: нормализация graphs→daily, идемпотентный ingest (ingest_receipts
   по ingest_id), upsert'ы дневных/постов/упоминаний/IG-серий (все ON CONFLICT DO UPDATE +
   COALESCE(EXCLUDED, existing) — повторный прогон дополняет, не затирает), снапшоты, velocity,
   сырые снапшоты + ретеншн-подрезка, месячный rollup. Извлечено ДОСЛОВНО из db.js — SQL и структура
   транзакций НЕ менялись (перевод inline-BEGIN на общий transaction-helper — отдельным PR 7.1).

   Зависит от pool + enabled (инъекция) + setChannelTgId (инъекция channelsRepo.setChannelTgId —
   ingestCollectorPayload штампует tg-id в той же транзакции; repos не импортят друг друга). num —
   нормализация дневных счётчиков: колонки теперь BIGINT (миграция 023), поэтому вместо прежнего
   INT4-клампа принимаем точные целые до MAX_SAFE_METRIC, а всё за границей честно даёт null (не
   выдуманное насыщенное значение). Ноль и null сохраняются как есть. */

const { toMetricInt: num } = require('../lib/metricNumber');

// Ретеншн ingest_receipts (см. pruneIngestReceipts). Продуктовый горизонт — 90 дней по received_at;
// размер батча и число батчей за прогон консервативны (≤ 20k строк/прогон — остаток добирают
// следующие прогоны). Прунинг ВЫКЛЮЧЕН по умолчанию: его зовёт maintenance только под явным флагом.
const INGEST_RECEIPTS_RETENTION_DAYS_DEFAULT = 90;
const INGEST_RECEIPTS_PRUNE_BATCH_DEFAULT = 500;
const INGEST_RECEIPTS_PRUNE_MAX_BATCHES_DEFAULT = 40;
const clampInt = (v, def, min, max) =>
  Number.isFinite(+v) ? Math.min(max, Math.max(min, Math.round(+v))) : def;

function createCollectorRepo({ pool, enabled, transaction, setChannelTgId }) {
  /* Pure transform: stats graphs → array of daily rows. Exported for testing.
     Builds the union of all days present across the daily series, so re-running
     refreshes the last ~3 months while older days already in the DB are kept. */
  function graphsToDailyRows(graphs) {
    if (!graphs || !graphs.available) return [];
    const map = {};
    const put = (ts, field, val) => {
      const d = new Date(Number(ts));
      if (isNaN(d.getTime())) return;
      const k = d.toISOString().slice(0, 10);
      (map[k] || (map[k] = { day: k }))[field] = num(val);
    };
    const g = graphs;
    if (g.growth && g.growth.x && g.growth.series && g.growth.series[0]) {
      g.growth.x.forEach((ts, i) => put(ts, 'subscribers', g.growth.series[0].values[i]));
    }
    if (g.followers && g.followers.x && g.followers.series) {
      const j = g.followers.series.find(s => /join|подпис/i.test(s.name)) || g.followers.series[0];
      const l = g.followers.series.find(s => /left|отпис/i.test(s.name)) || g.followers.series[1];
      g.followers.x.forEach((ts, i) => { if (j) put(ts, 'joins', j.values[i]); if (l) put(ts, 'leaves', l.values[i]); });
    }
    if (g.interactions && g.interactions.x && g.interactions.series) {
      const v = g.interactions.series.find(s => /view|просмотр/i.test(s.name)) || g.interactions.series[0];
      const s = g.interactions.series.find(s => /share|репост/i.test(s.name)) || g.interactions.series[1];
      g.interactions.x.forEach((ts, i) => { if (v) put(ts, 'views', v.values[i]); if (s) put(ts, 'forwards', s.values[i]); });
    }
    if (g.reactions_daily && g.reactions_daily.x && g.reactions_daily.values) {
      g.reactions_daily.x.forEach((ts, i) => put(ts, 'reactions', g.reactions_daily.values[i]));
    }
    return Object.values(map);
  }

  async function upsertChannelDaily(channelId, rows, executor = pool) {
    if (!enabled || !channelId || !rows || !rows.length) return 0;
    const sql = `INSERT INTO channel_daily
        (channel_id, source_id, day, subscribers, joins, leaves, views, forwards, reactions, captured_at)
      SELECT $1, (SELECT c.source_id FROM channels c WHERE c.id = $1),
             x.day::date, x.subscribers, x.joins, x.leaves, x.views, x.forwards, x.reactions, now()
        FROM jsonb_to_recordset($2::jsonb) AS x(
          day text, subscribers bigint, joins bigint, leaves bigint,
          views bigint, forwards bigint, reactions bigint
        )
      ON CONFLICT (channel_id, day) DO UPDATE SET
        source_id=COALESCE(EXCLUDED.source_id, channel_daily.source_id),
        subscribers=COALESCE(EXCLUDED.subscribers, channel_daily.subscribers),
        joins=COALESCE(EXCLUDED.joins, channel_daily.joins),
        leaves=COALESCE(EXCLUDED.leaves, channel_daily.leaves),
        views=COALESCE(EXCLUDED.views, channel_daily.views),
        forwards=COALESCE(EXCLUDED.forwards, channel_daily.forwards),
        reactions=COALESCE(EXCLUDED.reactions, channel_daily.reactions),
        captured_at=now()`;
    await executor.query(sql, [channelId, JSON.stringify(rows)]);
    return rows.length;
  }

  async function upsertPosts(channelId, rows, executor = pool) {
    if (!enabled || !channelId || !rows || !rows.length) return 0;
    const sql = `INSERT INTO posts
        (channel_id, source_id, post_id, date_published, views, reactions, forwards, replies,
         erv, virality, media_type, caption, hashtags, updated_at)
      SELECT $1, (SELECT c.source_id FROM channels c WHERE c.id = $1),
             x.post_id, x.date_published, x.views, x.reactions, x.forwards, x.replies,
             x.erv, x.virality, x.media_type, x.caption, x.hashtags, now()
        FROM jsonb_to_recordset($2::jsonb) AS x(
          post_id bigint, date_published timestamptz, views bigint, reactions bigint,
          forwards bigint, replies bigint, erv numeric, virality numeric,
          media_type text, caption text, hashtags jsonb
        )
      ON CONFLICT (channel_id, post_id) DO UPDATE SET
        source_id=COALESCE(EXCLUDED.source_id, posts.source_id),
        date_published=COALESCE(EXCLUDED.date_published, posts.date_published),
        -- NULL в свежем ре-ингесте = «метрика временно недоступна», не «стало ноль»: голый
        -- EXCLUDED затирал уже сохранённые значения (соседние daily-upsert'ы всегда COALESCE'ят)
        views=COALESCE(EXCLUDED.views, posts.views), reactions=COALESCE(EXCLUDED.reactions, posts.reactions),
        forwards=COALESCE(EXCLUDED.forwards, posts.forwards), replies=COALESCE(EXCLUDED.replies, posts.replies),
        erv=COALESCE(EXCLUDED.erv, posts.erv), virality=COALESCE(EXCLUDED.virality, posts.virality),
        media_type=COALESCE(EXCLUDED.media_type, posts.media_type),
        caption=COALESCE(EXCLUDED.caption, posts.caption),
        hashtags=COALESCE(EXCLUDED.hashtags, posts.hashtags), updated_at=now()`;
    await executor.query(sql, [channelId, JSON.stringify(rows)]);
    return rows.length;
  }

  // Persisted cover thumbnails for TG posts (central channel). rows: [{ post_id, size, jpeg_b64 }].
  // The trusted managed collect downloads a small JPEG per media post and hands the bytes here as
  // base64; JS decodes once to enforce JPEG/byte limits, then Postgres decode(...,'base64') stores
  // bytea. The upsert is idempotent per (channel, post, size): a post's media is immutable, so a
  // re-collect just refreshes the
  // same bytes. Served by getPostMedia in the open <img> proxy — which is why anonymous traffic reads
  // persisted PUBLIC bytes and never touches a decrypted session.
  async function upsertPostMedia(channelId, rows, executor = pool) {
    if (!enabled || !channelId || !rows || !rows.length) return 0;
    const MAX_THUMB_BYTES = 512 * 1024;
    const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
    const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
    let totalBytes = 0;
    const clean = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || row.post_id == null || !['sm', 'lg'].includes(row.size)) continue;
      const postId = String(row.post_id);
      const b64 = typeof row.jpeg_b64 === 'string' ? row.jpeg_b64 : '';
      if (!/^[1-9]\d{0,18}$/.test(postId) || !b64 || b64.length > 700_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
      if (BigInt(postId) > MAX_PG_BIGINT || seen.has(`${postId}:${row.size}`)) continue;
      const jpeg = Buffer.from(b64, 'base64');
      if (jpeg.length < 4 || jpeg.length > MAX_THUMB_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) continue;
      if (totalBytes + jpeg.length > MAX_TOTAL_BYTES) break;
      totalBytes += jpeg.length;
      seen.add(`${postId}:${row.size}`);
      // Re-encode the validated bytes so non-canonical base64 can never reach PostgreSQL decode().
      clean.push({ post_id: postId, size: row.size, jpeg_b64: jpeg.toString('base64') });
    }
    if (!clean.length) return 0;
    const sql = `INSERT INTO tg_post_media (channel_id, post_id, size, jpeg, updated_at)
      SELECT $1, x.post_id, COALESCE(x.size, 'sm'), decode(x.jpeg_b64, 'base64'), now()
        FROM jsonb_to_recordset($2::jsonb) AS x(post_id bigint, size text, jpeg_b64 text)
      ON CONFLICT (channel_id, post_id, size) DO UPDATE SET jpeg=EXCLUDED.jpeg, updated_at=now()`;
    await executor.query(sql, [channelId, JSON.stringify(clean)]);
    return clean.length;
  }

  // Read one persisted cover thumbnail (bytea → Buffer) for the open <img> proxy. Prefers the exact
  // requested size but falls back to 'sm' (the only size captured today), so a ?size=lg request still
  // yields a visible cover from Postgres instead of the revoked-session live path.
  async function getPostMedia(channelId, postId, size = 'sm') {
    if (!enabled || !channelId || postId == null) return null;
    const { rows } = await pool.query(
      `SELECT jpeg FROM tg_post_media
        WHERE channel_id=$1 AND post_id=$2 AND size IN ($3, 'sm')
        ORDER BY (size = $3) DESC LIMIT 1`,
      [channelId, postId, size]);
    return rows.length ? rows[0].jpeg : null;
  }

  async function upsertMentions(channelId, list, executor = pool) {
    if (!enabled || !channelId || !list || !list.length) return 0;
    const clean = list.filter(m => m.channel_id != null && m.msg_id != null);
    if (!clean.length) return 0;
    const sql = `INSERT INTO mentions
        (owner_channel_id, source_id, channel_id, msg_id, post_date, first_seen, last_seen,
         title, username, link, snippet, views, query)
      SELECT $1, (SELECT c.source_id FROM channels c WHERE c.id = $1),
             x.channel_id, x.msg_id, x.date, now(), now(),
             x.title, x.username, x.link, x.snippet, x.views, x.query
        FROM jsonb_to_recordset($2::jsonb) AS x(
          channel_id bigint, msg_id bigint, date timestamptz, title text, username text,
          link text, snippet text, views bigint, query text
        )
      ON CONFLICT (owner_channel_id, channel_id, msg_id) DO UPDATE SET
        last_seen=now(),
        views=COALESCE(EXCLUDED.views, mentions.views), title=COALESCE(EXCLUDED.title, mentions.title),
        username=COALESCE(EXCLUDED.username, mentions.username), link=COALESCE(EXCLUDED.link, mentions.link),
        snippet=COALESCE(EXCLUDED.snippet, mentions.snippet), query=COALESCE(EXCLUDED.query, mentions.query)`;
    await executor.query(sql, [channelId, JSON.stringify(clean)]);
    return clean.length;
  }

  async function saveSnapshot(channelId, data, executor = pool) {
    if (!enabled || !channelId || !data) return false;
    await executor.query(
      `INSERT INTO channel_snapshots (channel_id, data, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (channel_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [channelId, data]);
    return true;
  }

  /* Atomically accept a collector delivery. The receipt, current snapshot and all
     normalized archives commit together, so the dashboard never observes a new
     snapshot with only half of its history written. */
  async function ingestCollectorPayload(channelId, meta, data) {
    if (!enabled || !channelId) throw new Error('database unavailable');
    // Happy-path — в едином transaction-helper (BEGIN/COMMIT/ROLLBACK/release внутри). Failure-path
    // (ingest_receipts 'failed' + collector_status через pool — НОВОЕ соединение, ПОСЛЕ rollback) —
    // во внешнем catch, как было. Эквивалентно inline-BEGIN: duplicate-возврат внутри tx → COMMIT
    // (записей нет); INGEST_ID_CONFLICT → helper rollback+rethrow → внешний catch пропускает failure-writes.
    try {
      return await transaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO ingest_receipts
            (channel_id, ingest_id, schema_version, collector_version, collected_at, payload_hash)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (channel_id, ingest_id) DO NOTHING
           RETURNING status, result, payload_hash`,
          [channelId, meta.ingest_id, meta.schema_version, meta.collector_version,
            meta.collected_at, meta.payload_hash]);

        if (!inserted.rows.length) {
          const prior = await client.query(
            `SELECT status, result, payload_hash FROM ingest_receipts
              WHERE channel_id=$1 AND ingest_id=$2 FOR UPDATE`,
            [channelId, meta.ingest_id]);
          const receipt = prior.rows[0];
          if (!receipt || receipt.payload_hash !== meta.payload_hash) {
            const error = new Error('ingest_id already used with a different payload');
            error.code = 'INGEST_ID_CONFLICT';
            throw error;
          }
          if (receipt.status === 'completed') {
  return { ...(receipt.result || {}), duplicate: true };
          }
          await client.query(
            `UPDATE ingest_receipts
                SET status='processing', error=NULL, received_at=now()
              WHERE channel_id=$1 AND ingest_id=$2`,
            [channelId, meta.ingest_id]);
        }

        await saveSnapshot(channelId, data.snapshot, client);
        const nDaily = await upsertChannelDaily(channelId, data.dailyRows, client);
        const nPosts = await upsertPosts(channelId, data.postRows, client);
        const nMentions = await upsertMentions(channelId, data.mentions, client);
        let velocityOk = false;
        if (data.velocity && data.velocity.available) {
          await saveVelocity(channelId, data.velocity, client);
          velocityOk = true;
        }
        if (data.tgChannelId != null) await setChannelTgId(channelId, data.tgChannelId, client);

        const result = {
          ok: true,
          channel_id: channelId,
          ingest_id: meta.ingest_id,
          schema_version: meta.schema_version,
          snapshot: true,
          channel_daily: nDaily,
          posts: nPosts,
          velocity: velocityOk,
          mentions: nMentions,
        };
        await client.query(
          `UPDATE ingest_receipts
              SET status='completed', completed_at=now(), result=$3, error=NULL
            WHERE channel_id=$1 AND ingest_id=$2`,
          [channelId, meta.ingest_id, result]);
        await client.query(
          `INSERT INTO collector_status
            (channel_id, collector_version, last_ingest_id, last_attempt_at, last_success_at, last_error)
           VALUES ($1,$2,$3,now(),now(),NULL)
           ON CONFLICT (channel_id) DO UPDATE SET
             collector_version=EXCLUDED.collector_version,
             last_ingest_id=EXCLUDED.last_ingest_id,
             last_attempt_at=now(), last_success_at=now(), last_error=NULL, updated_at=now()`,
          [channelId, meta.collector_version, meta.ingest_id]);
        return result;
      });
    } catch (error) {
      if (error.code !== 'INGEST_ID_CONFLICT') {
        const message = String(error.message || error).slice(0, 1000);
        await pool.query(
          `INSERT INTO ingest_receipts
            (channel_id, ingest_id, schema_version, collector_version, collected_at,
             payload_hash, status, completed_at, error)
           VALUES ($1,$2,$3,$4,$5,$6,'failed',now(),$7)
           ON CONFLICT (channel_id, ingest_id) DO UPDATE SET
             status='failed', completed_at=now(), error=EXCLUDED.error
           WHERE ingest_receipts.status <> 'completed'`,
          [channelId, meta.ingest_id, meta.schema_version, meta.collector_version,
            meta.collected_at, meta.payload_hash, message]).catch(() => {});
        await pool.query(
          `INSERT INTO collector_status
            (channel_id, collector_version, last_ingest_id, last_attempt_at, last_error)
           VALUES ($1,$2,$3,now(),$4)
           ON CONFLICT (channel_id) DO UPDATE SET
             collector_version=EXCLUDED.collector_version,
             last_ingest_id=EXCLUDED.last_ingest_id,
             last_attempt_at=now(), last_error=EXCLUDED.last_error, updated_at=now()`,
          [channelId, meta.collector_version, meta.ingest_id, message]).catch(() => {});
      }
      throw error;
    }
  }

  /* Atomically persist ONE central daily-ingest bundle (the cron's /graphs + /posts + /velocity).
     The three upserts commit together so a mid-write crash never leaves channel_daily updated but
     posts/velocity not (the collector path already gets this via ingestCollectorPayload; the central
     cron did three separate autocommitted writes). Idempotent by construction — every upsert is
     ON CONFLICT DO UPDATE — so re-running the same day overwrites, never double-counts. The caller
     wraps this in runJobOnce('daily_ingest', 'central:<date>') so a double cron / second instance
     does the heavy MTProto pass at most once per day. */
  async function persistCentralDaily(channelId, { dailyRows = [], postRows = [], velocity = null } = {}) {
    if (!enabled || !channelId) throw new Error('database unavailable');
    return transaction(async (client) => {
      const nDaily = await upsertChannelDaily(channelId, dailyRows, client);
      const nPosts = await upsertPosts(channelId, postRows, client);
      let velocityOk = false;
      if (velocity && velocity.available) {
        await saveVelocity(channelId, velocity, client);
        velocityOk = true;
      }
      return { channel_daily: nDaily, posts: nPosts, velocity: velocityOk };
    });
  }

  // QR-канал: снапшот + дневные серии + посты — в ОДНОЙ транзакции (зеркало persistCentralDaily).
  // Раньше сервер-сайд QR-сбор писал это четырьмя автокоммитными вызовами (persistTgBundle в
  // index.js): сбой посередине оставлял канал со свежим снапшотом, но устаревшими daily/posts до
  // следующего идемпотентного прогона. Сырой graphs-снимок сюда НЕ входит — это опциональный
  // архив, вызывающий пишет его best-effort ПОСЛЕ коммита.
  async function persistTgBundleTx(channelId, { snapshot, dailyRows = [], postRows = [], velocity = null } = {}) {
    if (!enabled || !channelId) throw new Error('database unavailable');
    return transaction(async (client) => {
      await saveSnapshot(channelId, snapshot, client);
      // Return the persisted row counts (mirror of persistCentralDaily) so the managed-central
      // caller can apply the same channel_daily=0 degraded guard without a follow-up read. Previous
      // callers ignored the (undefined) return value, so adding one is backwards-compatible.
      const channel_daily = dailyRows.length ? await upsertChannelDaily(channelId, dailyRows, client) : 0;
      const posts = postRows.length ? await upsertPosts(channelId, postRows, client) : 0;
      // Velocity is threaded ONLY by the managed central collect (include_velocity=true в /qr/collect)
      // и коммитится в ТОЙ ЖЕ транзакции, что снапшот/daily/posts — как persistCentralDaily. Обычные
      // QR-каналы velocity не присылают (velocity=null) → ветка пропускается, поведение прежнее.
      // available:false (нет подходящих постов) НЕ пишется — velocity=true только на реальном payload.
      let velocityOk = false;
      if (velocity && velocity.available) {
        await saveVelocity(channelId, velocity, client);
        velocityOk = true;
      }
      return { channel_daily, posts, velocity: velocityOk };
    });
  }

  async function saveVelocity(channelId, data, executor = pool) {
    if (!enabled || !channelId || !data) return false;
    await executor.query(
      `INSERT INTO velocity_daily (channel_id, source_id, day, data, computed_at)
       VALUES ($1, (SELECT c.source_id FROM channels c WHERE c.id = $1), CURRENT_DATE, $2, now())
       ON CONFLICT (channel_id, day) DO UPDATE SET
         source_id = COALESCE(EXCLUDED.source_id, velocity_daily.source_id),
         data = EXCLUDED.data, computed_at = now()`,
      [channelId, data]);
    return true;
  }

  // Дневные метрики IG-аккаунта. rows: [{ day, followers, reach, views, profile_views,
  // accounts_engaged, total_interactions, likes, comments, saves, shares, follows, unfollows }].
  async function upsertIgDaily(channelId, rows, executor = pool) {
    if (!enabled || !channelId || !rows || !rows.length) return 0;
    const sql = `INSERT INTO ig_daily
        (channel_id, source_id, day, followers, followers_total, reach, views, profile_views, accounts_engaged,
         total_interactions, likes, comments, saves, shares, follows, unfollows, captured_at)
      SELECT $1, (SELECT a.source_id FROM ig_accounts a WHERE a.channel_id = $1),
             x.day::date, x.followers, x.followers_total, x.reach, x.views, x.profile_views, x.accounts_engaged,
             x.total_interactions, x.likes, x.comments, x.saves, x.shares, x.follows, x.unfollows, now()
        FROM jsonb_to_recordset($2::jsonb) AS x(
          day text, followers bigint, followers_total bigint, reach bigint, views bigint, profile_views bigint,
          accounts_engaged bigint, total_interactions bigint, likes bigint, comments bigint,
          saves bigint, shares bigint, follows bigint, unfollows bigint
        )
      ON CONFLICT (channel_id, day) DO UPDATE SET
        source_id=COALESCE(EXCLUDED.source_id, ig_daily.source_id),
        followers=COALESCE(EXCLUDED.followers, ig_daily.followers),
        followers_total=COALESCE(EXCLUDED.followers_total, ig_daily.followers_total),
        reach=COALESCE(EXCLUDED.reach, ig_daily.reach),
        views=COALESCE(EXCLUDED.views, ig_daily.views),
        profile_views=COALESCE(EXCLUDED.profile_views, ig_daily.profile_views),
        accounts_engaged=COALESCE(EXCLUDED.accounts_engaged, ig_daily.accounts_engaged),
        total_interactions=COALESCE(EXCLUDED.total_interactions, ig_daily.total_interactions),
        likes=COALESCE(EXCLUDED.likes, ig_daily.likes),
        comments=COALESCE(EXCLUDED.comments, ig_daily.comments),
        saves=COALESCE(EXCLUDED.saves, ig_daily.saves),
        shares=COALESCE(EXCLUDED.shares, ig_daily.shares),
        follows=COALESCE(EXCLUDED.follows, ig_daily.follows),
        unfollows=COALESCE(EXCLUDED.unfollows, ig_daily.unfollows),
        captured_at=now()`;
    await executor.query(sql, [channelId, JSON.stringify(rows)]);
    return rows.length;
  }

  // Per-media lifetime-инсайты по дням. rows: [{ media_id, day, reach, likes, comments,
  // saved, shares, views }]. Insights кумулятивны → каждый день — новая точка траектории.
  async function upsertIgMediaDaily(channelId, rows, executor = pool) {
    if (!enabled || !channelId || !rows || !rows.length) return 0;
    const clean = rows.filter(r => r && r.media_id != null);
    if (!clean.length) return 0;
    const sql = `INSERT INTO ig_media_daily
        (channel_id, source_id, media_id, day, reach, likes, comments, saved, shares, views, captured_at)
      SELECT $1, (SELECT a.source_id FROM ig_accounts a WHERE a.channel_id = $1),
             x.media_id, x.day::date, x.reach, x.likes, x.comments, x.saved, x.shares, x.views, now()
        FROM jsonb_to_recordset($2::jsonb) AS x(
          media_id text, day text, reach bigint, likes bigint, comments bigint,
          saved bigint, shares bigint, views bigint
        )
      ON CONFLICT (channel_id, media_id, day) DO UPDATE SET
        source_id=COALESCE(EXCLUDED.source_id, ig_media_daily.source_id),
        reach=COALESCE(EXCLUDED.reach, ig_media_daily.reach),
        likes=COALESCE(EXCLUDED.likes, ig_media_daily.likes),
        comments=COALESCE(EXCLUDED.comments, ig_media_daily.comments),
        saved=COALESCE(EXCLUDED.saved, ig_media_daily.saved),
        shares=COALESCE(EXCLUDED.shares, ig_media_daily.shares),
        views=COALESCE(EXCLUDED.views, ig_media_daily.views),
        captured_at=now()`;
    await executor.query(sql, [channelId, JSON.stringify(clean)]);
    return clean.length;
  }

  // Сырой снапшот «как есть». upsert по (channel,source,kind,day) — повторный прогон
  // за день перезаписывает, а не дублирует (как saveVelocity). day по умолчанию —
  // сегодня; payload обязателен и непустой (guard от затирания хорошего снимка null'ом).
  async function saveRawSnapshot(channelId, source, kind, day, payload, executor = pool) {
    if (!enabled || !channelId || !source || !kind || payload == null) return false;
    await executor.query(
      `INSERT INTO raw_snapshots (channel_id, source, kind, day, payload, created_at)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, now())
       ON CONFLICT (channel_id, source, kind, day)
         DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
      [channelId, source, kind, day || null, JSON.stringify(payload)]);
    return true;
  }

  // Ретеншн: raw_snapshots — append-only (полный /graphs с points:400 + почасовые
  // карты online_followers весят немало), поэтому кроном подрезаем старьё, иначе
  // таблица растёт безгранично. По умолчанию храним ~400 дней (> года истории).
  async function pruneRawSnapshots(maxAgeDays = 400) {
    if (!enabled) return 0;
    const days = Number.isFinite(+maxAgeDays) ? Math.max(1, Math.round(+maxAgeDays)) : 400;
    const { rowCount } = await pool.query(
      `DELETE FROM raw_snapshots WHERE day < (CURRENT_DATE - $1::int)`, [days]);
    return rowCount;
  }

  // Ретеншн ig_media_daily: новая строка на (media, day) для каждого «молодого» медиа
  // каждый прогон — растёт по мере появления новых постов, поэтому подрезаем старьё.
  // Горизонт щедрый (~2 года): дневная траектория медиа ценна вдолгую.
  async function pruneIgMediaDaily(maxAgeDays = 730) {
    if (!enabled) return 0;
    const days = Number.isFinite(+maxAgeDays) ? Math.max(1, Math.round(+maxAgeDays)) : 730;
    const { rowCount } = await pool.query(
      `DELETE FROM ig_media_daily WHERE day < (CURRENT_DATE - $1::int)`, [days]);
    return rowCount;
  }

  /* ── Ретеншн: ingest_receipts старше горизонта (по received_at) ────────────────────────────────
     Модель — pruneTerminalJobs/pruneEmailTokens. ingest_receipts append-only (одна строка на
     channel_id+ingest_id, идемпотентный приём collector'а): без прунинга растёт безгранично, а
     продуктовая политика хранит квитанции 90 дней. Режем строго по возрасту (received_at, момент
     последнего приёма/пере-приёма) — status-предиката нет, любая достаточно старая квитанция
     кандидат. Маленькие упорядоченные (received_at, channel_id, ingest_id) батчи опираются на
     ingest_receipts_prune_idx (025) → forward index range scan, стабильный план по мере роста.
     `FOR UPDATE SKIP LOCKED` КРИТИЧЕН: активный ingest берёт `FOR UPDATE` на свою квитанцию внутри
     транзакции — прунинг НИКОГДА не ждёт за ним (занятую строку доберёт следующий прогон), поэтому
     ночной ретеншн не тормозит живой приём. Удаление по составному PK (channel_id, ingest_id).
     Повторяемо/идемпотентно: capped-остаток добирает следующий прогон. Структурные счётчики
     { deleted, batches, capped }. DB-off → no-op. Клэмпы 1..3650 / 1..10000 / 1..1000. */
  async function pruneIngestReceipts({
    maxAgeDays = INGEST_RECEIPTS_RETENTION_DAYS_DEFAULT,
    batchSize = INGEST_RECEIPTS_PRUNE_BATCH_DEFAULT,
    maxBatches = INGEST_RECEIPTS_PRUNE_MAX_BATCHES_DEFAULT,
  } = {}) {
    if (!enabled) return { deleted: 0, batches: 0, capped: false };
    const days = clampInt(maxAgeDays, INGEST_RECEIPTS_RETENTION_DAYS_DEFAULT, 1, 3650);
    const limit = clampInt(batchSize, INGEST_RECEIPTS_PRUNE_BATCH_DEFAULT, 1, 10000);
    const caps = clampInt(maxBatches, INGEST_RECEIPTS_PRUNE_MAX_BATCHES_DEFAULT, 1, 1000);
    let deleted = 0;
    let batches = 0;
    let capped = false;
    for (;;) {
      if (batches >= caps) { capped = true; break; }
      const { rowCount } = await pool.query(
        `DELETE FROM ingest_receipts
          WHERE (channel_id, ingest_id) IN (
           SELECT channel_id, ingest_id FROM ingest_receipts
            WHERE received_at < now() - make_interval(days => $1)
            ORDER BY received_at, channel_id, ingest_id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )`,
        [days, limit]);
      batches += 1;
      deleted += rowCount;
      if (rowCount < limit) break;   // хвост исчерпан
    }
    return { deleted, batches, capped };
  }

  // ── Monthly rollup of channel_daily (capacity; 014_capacity_rollups.sql) ──────────────────────────
  // Idempotent upsert that folds the last `months` calendar months of channel_daily into
  // channel_monthly (one row per channel×month), so a long-range history read can serve ~24 monthly
  // points instead of scanning up to 730 daily rows per channel. Bounded to recent months so the
  // nightly recompute stays cheap. INERT until wired: nothing reads channel_monthly yet — the reader
  // (getChannelHistoryMonthly) lands with the frontend range-picker change (see CAPACITY doc §rollups).
  async function rollupChannelMonthly(months = 3) {
    if (!enabled) return 0;
    const m = Number.isFinite(+months) ? Math.max(1, Math.round(+months)) : 3;
    const { rowCount } = await pool.query(
      `INSERT INTO channel_monthly
         (channel_id, source_id, month, subscribers_end,
          joins_sum, leaves_sum, views_sum, forwards_sum, reactions_sum, days_count, computed_at)
       SELECT d.channel_id, MAX(c.source_id), date_trunc('month', d.day)::date AS month,
              (array_agg(d.subscribers ORDER BY d.day DESC) FILTER (WHERE d.subscribers IS NOT NULL))[1],
              COALESCE(SUM(d.joins),0), COALESCE(SUM(d.leaves),0), COALESCE(SUM(d.views),0),
              COALESCE(SUM(d.forwards),0), COALESCE(SUM(d.reactions),0), COUNT(*), now()
         FROM channel_daily d
         JOIN channels c ON c.id = d.channel_id
        WHERE d.day >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1)
        GROUP BY d.channel_id, date_trunc('month', d.day)
       ON CONFLICT (channel_id, month) DO UPDATE SET
         source_id       = COALESCE(EXCLUDED.source_id, channel_monthly.source_id),
         subscribers_end = EXCLUDED.subscribers_end,
         joins_sum       = EXCLUDED.joins_sum,
         leaves_sum      = EXCLUDED.leaves_sum,
         views_sum       = EXCLUDED.views_sum,
         forwards_sum    = EXCLUDED.forwards_sum,
         reactions_sum   = EXCLUDED.reactions_sum,
         days_count      = EXCLUDED.days_count,
         computed_at     = now()`,
      [m]);
    return rowCount;
  }

            // ── Instagram tags (media where we're @-tagged) — archive so they persist past the live edge's window.
  //    Write (finding 7: upsert — collector-домен, чтение — analyticsRepo.getIgTags).
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
         num(r.like_count), num(r.comments_count),
         r.timestamp || null],
      );
      n++;
    }
    return n;
  }

  return {
    upsertIgTags,
    graphsToDailyRows,
    upsertChannelDaily, upsertPosts, upsertMentions,
    upsertPostMedia, getPostMedia,
    saveSnapshot, saveVelocity,
    ingestCollectorPayload, persistCentralDaily, persistTgBundleTx,
    upsertIgDaily, upsertIgMediaDaily,
    saveRawSnapshot, pruneRawSnapshots, pruneIgMediaDaily, pruneIngestReceipts, rollupChannelMonthly,
  };
}

module.exports = { createCollectorRepo };
