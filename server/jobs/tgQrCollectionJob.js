// ═══════════════════════════════════════════════════════════════
//  Atlavue — сбор QR-каналов через пользовательские сессии (job)
// ═══════════════════════════════════════════════════════════════
// Collect QR-connected channels (source='qr') into Postgres using each user's stored
// session — the server acts as their collector, so the dashboard renders them like any
// collector channel. Тела перенесены из index.js literal (PR E); без Express/env/таймеров.
// Sessions are decrypted ONLY here and handed to the isolated mtproto /qr/collect —
// never logged, never sent to a client.

'use strict';

function createTgQrCollectionJob({ db, log, tgCrypto, mtprotoPost, MTPROTO_TOKEN, MTPROTO_TIMEOUT_HEAVY_MS, tgPostToRow }) {
  // Write one channel's collected bundle to Postgres exactly like a collector push: the snapshot
  // (what /api/tg/full + the /api/tg/mtproto/* routes serve for non-central channels) plus the
  // time-series (channel_daily from graphs, posts). Best-effort per part.
  async function persistTgBundle(channelId, bundle, day) {
    if (!channelId || !bundle || typeof bundle !== 'object') return;
    const posts = Array.isArray(bundle.posts) ? bundle.posts : [];
    const hasGraphs = !!(bundle.graphs && bundle.graphs.available);
    // Снапшот + daily + посты коммитятся ВМЕСТЕ (db.persistTgBundleTx) — раньше это были
    // отдельные автокоммитные записи, и сбой посередине оставлял QR-канал со свежим
    // снапшотом, но устаревшими daily/posts до следующего идемпотентного прогона.
    await db.persistTgBundleTx(channelId, {
      snapshot: {
        channel:       bundle.channel || {},
        views_summary: bundle.views_summary || null,
        posts,
        stats:         bundle.stats || null,
        graphs:        bundle.graphs || null,
      },
      dailyRows: hasGraphs ? db.graphsToDailyRows(bundle.graphs) : [],
      postRows: posts.map(tgPostToRow),
    });
    // Сырой graphs-снимок — опциональный архив: best-effort ПОСЛЕ коммита, как раньше,
    // но с логом (тихий .catch(() => {}) прятал реальные, actionable-ошибки записи).
    if (hasGraphs) {
      await db.saveRawSnapshot(channelId, 'tg', 'graphs', day, bundle.graphs).catch((e) =>
        log('warn', 'tg_qr_raw_snapshot_failed', { channelId, error: e.message }));
    }
  }

  // Fetch one QR channel's bundle via the (already-decrypted) session and persist it. Throws on
  // mtproto/collect failure — callers decide how to handle (log + continue).
  async function collectQrChannel(sessionStr, ch, day) {
    const ref = ch.username || String(ch.tg_channel_id);
    const bundle = await mtprotoPost('/qr/collect', {
      body: { session: sessionStr, channel: ref, posts_limit: 100, graph_points: 400 },
      timeoutMs: MTPROTO_TIMEOUT_HEAVY_MS,
    });
    await persistTgBundle(ch.id, bundle, day);
  }

  // Immediate best-effort collection for freshly-added channels so the dashboard fills within seconds
  // instead of waiting for the nightly cron. Fire-and-forget; sequential (kind to the user's session's
  // flood limits); never throws to the caller.
  async function collectQrChannelsNow(sess, channels) {
    if (!sess || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
    let sessionStr;
    try { sessionStr = tgCrypto.decrypt(sess.session_enc); } catch { return; }
    const day = new Date().toISOString().slice(0, 10);
    for (const ch of channels) {
      if (!ch || ch.tg_channel_id == null) continue;
      try { await collectQrChannel(sessionStr, ch, day); }
      catch (e) { log('error', 'tg_qr_collect_now_failed', { channelId: ch.id, error: e.message }); }
    }
  }

  // Runs fire-and-forget after the central ingest; durable per (channel, day) so a repeat trigger
  // resumes unfinished channels; sequential + per-channel try/catch so one bad session / channel /
  // FloodWait never blocks the others or the critical central ingest.
  const TG_QR_MAX_CHANNELS_PER_RUN = 200;

  async function processTgQrCollection() {
    if (!db.enabled || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
    const day = new Date().toISOString().slice(0, 10);
    let sessions = [];
    try { sessions = await db.listTgSessions(); }
    catch (e) { log('error', 'tg_qr_list_sessions_failed', { error: e.message }); return; }

    let done = 0, collected = 0, skipped = 0, failed = 0, capped = false;
    for (const s of sessions) {
      if (done >= TG_QR_MAX_CHANNELS_PER_RUN) { capped = true; break; }
      let sessionStr;
      try { sessionStr = tgCrypto.decrypt(s.session_enc); }
      catch { log('error', 'tg_qr_decrypt_failed', { uid: s.uid }); continue; }

      let chans = [];
      try { chans = (await db.listChannels({ uid: s.uid })).filter((c) => c.source === 'qr' && c.tg_channel_id != null); }
      catch (e) { log('error', 'tg_qr_list_channels_failed', { uid: s.uid, error: e.message }); continue; }

      for (const ch of chans) {
        if (done >= TG_QR_MAX_CHANNELS_PER_RUN) { capped = true; break; }
        let started = false;
        try {
          const out = await db.runJobOnce('qr_collect', `${ch.id}:${day}`, () => {
            started = true;
            return collectQrChannel(sessionStr, ch, day);
          });
          if (out.skipped) { skipped++; continue; }
          done++;
          collected++;
        }
        catch (e) {
          if (started) done++;
          failed++;
          log('error', 'tg_qr_collect_failed', { channelId: ch.id, error: e.message });
        }
      }
    }
    log(capped ? 'warn' : 'info', 'tg_qr_collection_done', { collected, skipped, failed, capped });
  }

  return { collectQrChannelsNow, processTgQrCollection };
}

module.exports = { createTgQrCollectionJob };
