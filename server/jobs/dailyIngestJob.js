// ═══════════════════════════════════════════════════════════════
//  Atlavue — дневной TG-ingest центрального канала (job)
// ═══════════════════════════════════════════════════════════════
// Бывшее тело POST /api/ingest/daily из app.js (PR E): тяжёлый MTProto-проход
// (graphs+posts+velocity) под runJobOnce-идемпотентностью + post-response хвосты дня.
// run({requestId, base}) возвращает {status, body, tails?} — роут в app.js оставляет
// себе ТОЛЬКО токен-гейт и отправку ответа; tails() он зовёт ПОСЛЕ res.json (как раньше:
// хвосты не задерживают и не ломают ответ крону). Без Express/env/таймеров.

'use strict';

function createDailyIngestJob({
  db, log, mtprotoFetch, MTPROTO_TIMEOUT_STATS_MS, MTPROTO_TIMEOUT_HEAVY_MS, tgPostToRow,
  processReportSchedules, processPersistence, processTgQrCollection,
}) {
  async function run({ requestId, base }) {
    if (!db.enabled) return { status: 200, body: { ok: false, reason: 'DATABASE_URL не задан — БД выключена' } };
    const channelId = await db.getOwnerChannelId();   // central channel = "collector #0"
    if (!channelId) return { status: 503, body: { ok: false, reason: 'central channel not ready' } };
    // Idempotency (Ковчег): a double cron tick / a second web instance must NOT run the heavy
    // MTProto pass (/graphs + /posts + up to ~12 GetMessageStats for velocity) twice for the same
    // day. runJobOnce keyed on the UTC date makes exactly one caller do the work; a duplicate gets
    // the first run's cached result and skips both the fetch AND the post-response tails below.
    const dateKey = new Date().toISOString().slice(0, 10);
    let graphs = null;

    // Хвосты дня (отчёты / IG-персистенс / QR-сбор) запускаются ПОСЛЕ ответа крону:
    // они не должны ни задерживать, ни ломать TG-ingest. Возвращаются вызывающему функцией,
    // потому что запускаются и на успехе, и на degraded-тике: IG-сбор и отчёты от TG-graphs
    // не зависят, и их день не должен теряться из-за деградации Telegram-стороны. Их внутренняя
    // идемпотентность (runJobOnce per report+period, durable per channel+day) делает повторный
    // запуск на успешном same-day-ретрае безопасным.
    const tails = () => Promise.all([
      processReportSchedules(base).catch(e =>
        log('error', 'report_schedule_failed', { request_id: requestId, error: e.message })),
      // `graphs` уже в руках (null на degraded-тике — сырой TG-снимок тогда просто пропускается).
      processPersistence(channelId, graphs).catch(e =>
        log('error', 'persistence_failed', { request_id: requestId, error: e.message })),
      processTgQrCollection().catch(e =>
        log('error', 'tg_qr_collection_failed', { request_id: requestId, error: e.message })),
    ]);

    try {
      const outcome = await db.runJobOnce('daily_ingest', `central:${dateKey}`, async () => {
        let posts;
        [graphs, posts] = await Promise.all([
          mtprotoFetch('/graphs', { points: 400 }, MTPROTO_TIMEOUT_HEAVY_MS).catch(() => null),   // full range for the archive (dashboard uses 45)
          mtprotoFetch('/posts', { limit: 100 }, MTPROTO_TIMEOUT_STATS_MS).catch(() => null),
        ]);
        const velocity = await mtprotoFetch('/velocity', {}, MTPROTO_TIMEOUT_HEAVY_MS).catch(() => null);
        // All three upserts commit together (persistCentralDaily) — no half-written day.
        const persisted = await db.persistCentralDaily(channelId, {
          dailyRows: db.graphsToDailyRows(graphs),
          postRows: (posts && Array.isArray(posts.posts)) ? posts.posts.map(tgPostToRow) : [],
          velocity,
        });
        // Наблюдаемость тихой смерти архива: для рабочего центрального канала graphsToDailyRows
        // всегда отдаёт полный диапазон, поэтому channel_daily=0 означает не «пустой день», а
        // упавший тяжёлый MTProto-fetch (graphs=null). Бросаем ПОСЛЕ коммита (частичные
        // posts/velocity сохранены, upsert'ы идемпотентны) — runJobOnce запишет строку failed,
        // и повторный тик ТОГО ЖЕ дня переклеймит её и повторит тяжёлый проход. Раньше пустой
        // день записывался как succeeded, и same-day ретрай был невозможен без ручного
        // удаления jobs-строки, а velocity-снимок дня терялся навсегда.
        if ((persisted.channel_daily || 0) === 0) {
          const err = new Error('channel_daily=0 — upstream MTProto /graphs failed, archive did not grow');
          err.code = 'INGEST_DEGRADED';
          throw err;
        }
        return persisted;
      });

      if (outcome.skipped) {
        const job = outcome.job;
        // Дубль-тик, пока первый прогон ещё под lease (status='running'): это НЕ деградация —
        // отвечаем in_progress без алерта (раньше пустой result давал ложный degraded:true).
        if (!job || job.status !== 'succeeded') {
          return { status: 200, body: { ok: true, skipped: true, in_progress: true } };
        }
        // Дубль успешного дня: succeeded теперь гарантированно непустой (пустой день = failed).
        const cached = job.result || {};
        return { status: 200, body: { ok: true, degraded: false, skipped: true, channel_daily: cached.channel_daily || 0, posts: cached.posts || 0, velocity: !!cached.velocity } };
      }

      const result = outcome.result;
      return {
        status: 200,
        body: { ok: true, degraded: false, skipped: false, channel_daily: result.channel_daily || 0, posts: result.posts || 0, velocity: !!result.velocity },
        tails,
      };
    } catch (e) {
      if (e && e.code === 'INGEST_DEGRADED') {
        // Крон роняет джобу по не-200 (нативное письмо GitHub = бесплатный проактивный алерт),
        // а лог даёт greppable-сигнал. Строка jobs уже failed → ретрай того же дня возможен.
        log('error', 'ingest_degraded', {
          request_id: requestId,
          reason: 'channel_daily=0 (upstream MTProto /graphs likely failed) — archive did not grow',
        });
        return { status: 503, body: { ok: false, degraded: true, retryable: true, request_id: requestId }, tails };
      }
      // keep the { ok:false } shape for the cron, but never leak internals in the message
      log('error', 'ingest_daily_failed', { request_id: requestId, error: e.message, stack: e.stack });
      return { status: 500, body: { ok: false, error: 'internal_error', request_id: requestId } };
    }
  }

  return { run };
}

module.exports = { createDailyIngestJob };
