// ═══════════════════════════════════════════════════════════════
//  Atlavue — сбор QR-каналов через пользовательские сессии (job)
// ═══════════════════════════════════════════════════════════════
// Collect QR-connected channels (source='qr') into Postgres using each user's stored
// session — the server acts as their collector, so the dashboard renders them like any
// collector channel. Тела перенесены из index.js literal (PR E); без Express/env/таймеров.
// Sessions are decrypted ONLY here and handed to the isolated mtproto /qr/collect —
// never logged, never sent to a client.

'use strict';

// Auth-ошибка сессии = сама StringSession недействительна (юзер снёс сессию/сменил пароль/2FA-ревок).
// Python-сервис отдаёт её ровно двумя стабильными кодами (mtproto-client кладёт их в e.code):
// 401 'session_unauthorized' (QR-путь) и 503 'mtproto_session_unauthorized' (stats-путь). Матчим
// ТОЧНО по коду — не по тексту, который русифицируется/меняется.
function isTgAuthError(e) {
  return !!e && (e.code === 'session_unauthorized' || e.code === 'mtproto_session_unauthorized');
}

// Не-auth сбой (upstream/flood/сеть) → безопасный код для degraded-состояния. Никогда не пишем
// сырой e.message (может нести секрет/PII) — только стабильный код; repo дополнительно фильтрует.
const TG_KNOWN_ERROR_CODES = new Set([
  'mtproto_timeout', 'mtproto_unreachable', 'mtproto_error', 'internal_error',
]);
function safeTgErrorCode(e) {
  if (e && e.floodWait) return 'flood_wait';
  if (e && TG_KNOWN_ERROR_CODES.has(e.code)) return e.code;
  return 'collect_failed';
}

function createTgQrCollectionJob({ db, log, tgCrypto, mtprotoPost, MTPROTO_TOKEN, MTPROTO_TIMEOUT_HEAVY_MS, tgPostToRow }) {
  // Persist the health outcome for ONE session after its channels were processed. Priority:
  // auth-fail > success > degraded. Success wins over any non-auth error (an earlier channel that
  // collected proves the session is live); auth-fail wins over everything (session is now invalid).
  // Health-bookkeeping НИКОГДА не роняет сбор: любая ошибка записи логируется и глотается.
  async function finalizeSessionHealth(uid, sessionVersion, { attempted, succeeded, authFailed, errorCode }) {
    if (!uid || !sessionVersion || !attempted) return;   // every run skipped / nothing started → health untouched
    try {
      await db.recordTgSessionAttempt(uid, sessionVersion);
    } catch (e) {
      log('error', 'tg_qr_health_update_failed', { uid, phase: 'attempt', error: e.message });
    }
    // Keep the outcome write independent from the attempt write. The outcome methods also stamp
    // last_attempt_at, so a brief failure of the first UPDATE cannot hide an actionable auth result.
    try {
      if (authFailed) {
        await db.recordTgSessionFailure(uid, sessionVersion, { state: 'reauth_required', errorCode: errorCode || 'session_unauthorized' });
      } else if (succeeded) {
        await db.recordTgSessionSuccess(uid, sessionVersion);
      } else {
        await db.recordTgSessionFailure(uid, sessionVersion, { state: 'degraded', errorCode: errorCode || 'collect_failed' });
      }
    } catch (e) {
      log('error', 'tg_qr_health_update_failed', { uid, phase: 'outcome', error: e.message });
    }
  }

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
    const counts = await db.persistTgBundleTx(channelId, {
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
    return counts || { channel_daily: 0, posts: 0 };
  }

  // Fetch one QR channel's bundle via the (already-decrypted) session and persist it. Throws on
  // mtproto/collect failure — callers decide how to handle (log + continue).
  async function collectQrChannel(sessionStr, ch, day) {
    const ref = ch.username || String(ch.tg_channel_id);
    const bundle = await mtprotoPost('/qr/collect', {
      body: { session: sessionStr, channel: ref, posts_limit: 100, graph_points: 400 },
      timeoutMs: MTPROTO_TIMEOUT_HEAVY_MS,
    });
    const counts = await persistTgBundle(ch.id, bundle, day);
    return { bundle, channel_daily: counts.channel_daily || 0, posts: counts.posts || 0 };
  }

  // Managed collection of ONE channel (the central channel) through the owner's stored session — the
  // repair path the daily ingest prefers over the (now-revoked) global env TG_SESSION. Unlike
  // collectQrChannelsNow (best-effort, swallows), this one RETHROWS so the caller can fall back to the
  // global live path; every validated prerequisite (crypto, token, decryptable session, known tg id)
  // fails here as a throw. The plaintext session is decrypted only server-side and is sent solely
  // inside the mtprotoPost('/qr/collect') JSON body — never returned, logged, or put on a URL.
  async function collectManagedChannelNow(sess, channel, day) {
    if (!sess || !channel || channel.tg_channel_id == null) {
      const e = new Error('managed_channel_missing_prereq'); e.code = 'managed_prereq'; throw e;
    }
    if (!tgCrypto.configured() || !MTPROTO_TOKEN) {
      const e = new Error('managed_channel_not_configured'); e.code = 'managed_not_configured'; throw e;
    }
    let sessionStr;
    try { sessionStr = tgCrypto.decrypt(sess.session_enc); }
    catch { const e = new Error('managed_channel_decrypt_failed'); e.code = 'session_decrypt_failed'; throw e; }
    const theDay = day || new Date().toISOString().slice(0, 10);
    try {
      const out = await collectQrChannel(sessionStr, channel, theDay);
      // A real, completed attempt for THIS session generation → healthy (generation-guarded).
      await finalizeSessionHealth(sess.uid, sess.session_version, { attempted: true, succeeded: true, authFailed: false, errorCode: null });
      return { bundle: out.bundle, channel_daily: out.channel_daily, posts: out.posts };
    } catch (e) {
      const authFailed = isTgAuthError(e);
      await finalizeSessionHealth(sess.uid, sess.session_version, {
        attempted: true, succeeded: false, authFailed, errorCode: authFailed ? e.code : safeTgErrorCode(e),
      });
      throw e;   // caller falls back to the global live path
    }
  }

  // Immediate best-effort collection for freshly-added channels so the dashboard fills within seconds
  // instead of waiting for the nightly cron. Fire-and-forget; sequential (kind to the user's session's
  // flood limits); never throws to the caller.
  async function collectQrChannelsNow(sess, channels) {
    if (!sess || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
    let sessionStr;
    try { sessionStr = tgCrypto.decrypt(sess.session_enc); } catch { return; }
    const day = new Date().toISOString().slice(0, 10);
    // Same health semantics as the nightly job: auth-fail short-circuits the remaining channels for
    // this session; a single successful collect wins over any non-auth failure. Каждый вызов
    // collectQrChannel — реальная (стартовавшая) попытка, поэтому здесь нет runJobOnce-skip-ветки.
    let attempted = false, succeeded = false, authFailed = false, lastErrCode = null;
    for (const ch of channels) {
      if (!ch || ch.tg_channel_id == null) continue;
      attempted = true;
      try { await collectQrChannel(sessionStr, ch, day); succeeded = true; }
      catch (e) {
        log('error', 'tg_qr_collect_now_failed', { channelId: ch.id, error: e.message });
        if (isTgAuthError(e)) { authFailed = true; lastErrCode = e.code; break; }
        lastErrCode = safeTgErrorCode(e);
      }
    }
    await finalizeSessionHealth(sess.uid, sess.session_version, { attempted, succeeded, authFailed, errorCode: lastErrCode });
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

      // Per-session health accounting. A `skipped` idempotent result is NOT an attempt (nothing
      // started); only a collection whose fn actually ran counts. Success wins over non-auth errors,
      // auth-fail short-circuits this user's remaining channels (session-wide invalidation).
      let attempted = false, succeeded = false, authFailed = false, lastErrCode = null;
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
          attempted = true;
          succeeded = true;
        }
        catch (e) {
          if (started) { done++; attempted = true; }
          failed++;
          log('error', 'tg_qr_collect_failed', { channelId: ch.id, error: e.message });
          if (isTgAuthError(e)) { authFailed = true; lastErrCode = e.code; break; }
          lastErrCode = safeTgErrorCode(e);
        }
      }

      await finalizeSessionHealth(s.uid, s.session_version, { attempted, succeeded, authFailed, errorCode: lastErrCode });
    }
    log(capped ? 'warn' : 'info', 'tg_qr_collection_done', { collected, skipped, failed, capped });
  }

  return { collectQrChannelsNow, collectManagedChannelNow, processTgQrCollection };
}

module.exports = { createTgQrCollectionJob };
