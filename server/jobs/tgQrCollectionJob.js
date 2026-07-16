// ═══════════════════════════════════════════════════════════════
//  Atlavue — сбор QR-каналов через пользовательские сессии (job)
// ═══════════════════════════════════════════════════════════════
// Collect QR-connected channels (source='qr') into Postgres using each user's stored
// session — the server acts as their collector, so the dashboard renders them like any
// collector channel. Тела перенесены из index.js literal (PR E); без Express/env/таймеров.
// Sessions are decrypted ONLY here and handed to the isolated mtproto /qr/collect —
// never logged, never sent to a client.

'use strict';

const { createTgSessionDecryptor } = require('../lib/tgSessionDecrypt');
const { decodeBoundedJpegBase64 } = require('../lib/tgChannelPhoto');

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

function sameUid(left, right) {
  return left != null && right != null && String(left) === String(right);
}

// Telegram/Telethon can represent a channel either as its raw positive id or as the marked
// -100… peer id. Normalize with BigInt so the private entity response can be bound to the exact DB
// channel without losing precision. Returns null for malformed input.
function rawTgChannelId(value) {
  try {
    const id = BigInt(String(value));
    if (id <= -1000000000000n) return String(-id - 1000000000000n);
    return String(id < 0n ? -id : id);
  } catch {
    return null;
  }
}

function createTgQrCollectionJob({ db, liveDb = db, log, tgCrypto, mtprotoPost, MTPROTO_TOKEN, MTPROTO_TIMEOUT_STATS_MS, MTPROTO_TIMEOUT_HEAVY_MS, tgPostToRow, tgQrChannelsPerPass = 200, tgMediaRepairPerPass = 16, tgMediaRepairWindowDays = 365 }) {
  // Shared decrypt: transparently falls back to a rotated-out key and lazily re-encrypts the row under
  // the active key (generation-guarded, best-effort — a rewrite failure never blocks the collect).
  const { decryptTgSession } = createTgSessionDecryptor({ tgCrypto, db, log });
  const { decryptTgSession: decryptLiveTgSession } = liveDb === db
    ? { decryptTgSession }
    : createTgSessionDecryptor({ tgCrypto, db: liveDb, log });

  // Persist the health outcome for ONE session after its channels were processed. Priority:
  // auth-fail > success > degraded. Success wins over any non-auth error (an earlier channel that
  // collected proves the session is live); auth-fail wins over everything (session is now invalid).
  // Health-bookkeeping НИКОГДА не роняет сбор: любая ошибка записи логируется и глотается.
  async function finalizeSessionHealth(uid, sessionVersion, { attempted, succeeded, authFailed, errorCode }, database = db) {
    if (!uid || !sessionVersion || !attempted) return;   // every run skipped / nothing started → health untouched
    try {
      await database.recordTgSessionAttempt(uid, sessionVersion);
    } catch (e) {
      log('error', 'tg_qr_health_update_failed', { uid, phase: 'attempt', error: e.message });
    }
    // Keep the outcome write independent from the attempt write. The outcome methods also stamp
    // last_attempt_at, so a brief failure of the first UPDATE cannot hide an actionable auth result.
    try {
      if (authFailed) {
        await database.recordTgSessionFailure(uid, sessionVersion, { state: 'reauth_required', errorCode: errorCode || 'session_unauthorized' });
      } else if (succeeded) {
        await database.recordTgSessionSuccess(uid, sessionVersion);
      } else {
        await database.recordTgSessionFailure(uid, sessionVersion, { state: 'degraded', errorCode: errorCode || 'collect_failed' });
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
    // Central avatar: the managed collect (include_media) may carry a bounded base64 JPEG channel
    // photo. Validate + re-encode canonically ONCE here (a malformed/oversized blob decodes to null and
    // is simply dropped — best-effort, never fails the write) and store it as a TOP-LEVEL snapshot
    // field (sibling of `channel`), so /api/tg/full keeps returning only d.channel and never ships the
    // blob, while the open /channel/photo proxy can read it DB-first and survive a stale global session.
    let photoBuf = decodeBoundedJpegBase64(bundle.channel_photo);
    // A single transient photo download must not erase a previously captured avatar when the whole
    // snapshot is replaced. Preserve the last validated public JPEG; a later successful collect
    // replaces it. (Telegram exposes no reliable distinction between "no photo" and download error.)
    if (!photoBuf && typeof db.getSnapshotInternal === 'function') {
      const previous = await db.getSnapshotInternal(channelId).catch(() => null);
      photoBuf = decodeBoundedJpegBase64(previous?.data?.channel_photo);
    }
    const channelPhoto = photoBuf ? photoBuf.toString('base64') : null;
    const counts = await db.persistTgBundleTx(channelId, {
      snapshot: {
        channel:       bundle.channel || {},
        views_summary: bundle.views_summary || null,
        posts,
        stats:         bundle.stats || null,
        graphs:        bundle.graphs || null,
        ...(channelPhoto ? { channel_photo: channelPhoto } : {}),
      },
      dailyRows: hasGraphs ? db.graphsToDailyRows(bundle.graphs) : [],
      postRows: posts.map(tgPostToRow),
      // velocity присутствует ТОЛЬКО в бандле central-канала (include_velocity=true) — коммитится в
      // той же транзакции. У обычных QR-каналов bundle.velocity нет → null → ничего не пишется.
      velocity: bundle.velocity || null,
    });
    // Media is deliberately best-effort AFTER the product transaction. A malformed/oversized cover
    // or a storage failure must never roll back fresh snapshot/daily/posts/velocity; the next managed
    // collect can fill the immutable thumbnail again. Only central collection opts into thumbs.
    const thumbs = Array.isArray(bundle.thumbs) ? bundle.thumbs : [];
    if (thumbs.length && typeof db.upsertPostMedia === 'function') {
      await db.upsertPostMedia(channelId, thumbs).catch(() =>
        log('warn', 'tg_post_media_persist_failed', { channelId, error: 'write_failed' }));
    }
    // Сырой graphs-снимок — опциональный архив: best-effort ПОСЛЕ коммита, как раньше,
    // но с логом (тихий .catch(() => {}) прятал реальные, actionable-ошибки записи).
    if (hasGraphs) {
      await db.saveRawSnapshot(channelId, 'tg', 'graphs', day, bundle.graphs).catch((e) =>
        log('warn', 'tg_qr_raw_snapshot_failed', { channelId, error: e.message }));
    }
    return counts || { channel_daily: 0, posts: 0, velocity: false };
  }

  // Read the persisted Telegram entity identity for the warm collection path. Feature-detected so a
  // db without the method (or a channel with no stored hash yet) simply falls back to the cold path —
  // the access_hash is a decimal STRING (pg BIGINT), passed to mtproto untouched (never via Number).
  async function loadStoredAccessHash(ch, uid, gen, database = db) {
    if (typeof database.getTgChannelIdentity !== 'function') return null;
    const ident = await database.getTgChannelIdentity(ch.id, uid).catch(() => null);
    if (!ident || ident.tg_access_hash == null || ident.tg_access_hash_version == null) return null;
    if (rawTgChannelId(ident.tg_channel_id) !== rawTgChannelId(ch.tg_channel_id)) return null;
    // access_hash is account/session-scoped. A reconnect increments session_version, so the first
    // collection with the new credential deliberately takes the cold path and replaces the hash.
    return String(ident.tg_access_hash_version) === String(gen)
      ? String(ident.tg_access_hash)
      : null;
  }

  // Persist the access_hash mtproto resolved for THIS channel, generation-guarded by the collecting
  // session generation so a late older-generation write can't clobber a newer one. Best-effort: a
  // failure only costs the next collect a one-time dialog resync, so it never blocks the collect. The
  // hash itself is NEVER logged (only a fixed safe code + channel id).
  async function persistResolvedIdentity(ch, bundle, uid, gen, storedAccessHash, database = db) {
    if (typeof database.saveTgChannelAccessHash !== 'function') return;
    const entity = bundle && bundle.entity;
    const hash = entity && entity.access_hash != null ? String(entity.access_hash) : null;
    if (!hash || entity.id == null || ch.tg_channel_id == null || gen == null || !sameUid(ch.owner_uid, uid)) return;
    if (rawTgChannelId(entity.id) !== rawTgChannelId(ch.tg_channel_id)) {
      log('warn', 'tg_access_hash_identity_mismatch', { channelId: ch.id, error: 'identity_mismatch' });
      const error = new Error('tg_entity_identity_mismatch');
      error.code = 'collect_failed';
      throw error;
    }
    if (hash === storedAccessHash) return; // warm hit: do not pay for a no-op UPDATE every day
    try {
      await database.saveTgChannelAccessHash(ch.id, uid, hash, gen);
    } catch {
      log('warn', 'tg_access_hash_persist_failed', { channelId: ch.id, error: 'write_failed' });
    }
  }

  // Fetch one QR channel's bundle via the (already-decrypted) session and persist it. Throws on
  // mtproto/collect failure — callers decide how to handle (log + continue). `gen` is the collecting
  // session generation (session_version); it guards the resolved-identity write.
  async function collectQrChannel(sessionStr, ch, day, uid, gen, { includeVelocity = false, includeMedia = false } = {}) {
    const ref = ch.username || String(ch.tg_channel_id);
    // Warm path: a persisted access_hash lets mtproto address a PRIVATE channel directly instead of
    // scanning up to 1000 dialogs on the fresh StringSession just to recover it. Sent in the POST body
    // (never a URL/query) as a decimal string; absent for cold legacy rows → the cold resync still runs.
    const accessHash = ch.username ? null : await loadStoredAccessHash(ch, uid, gen);
    const body = { session: sessionStr, channel: ref, posts_limit: 100, graph_points: 400 };
    if (accessHash != null) body.access_hash = accessHash;
    // include_velocity is an explicit opt-in: ONLY the managed central collect sets it, so ordinary QR
    // channels never pay the up-to-12 GetMessageStats fanout. Sent as a boolean in the private body.
    if (includeVelocity) body.include_velocity = true;
    // include_media is the same shape of opt-in: ONLY the central collect asks mtproto to also download
    // each post's small cover thumbnail (bounded, time-boxed, best-effort) so the open <img> proxy can
    // serve covers DB-first. Ordinary QR channels never pay the extra downloads.
    if (includeMedia) body.include_media = true;
    // Background lane on the breaker: every /qr/collect (managed central, recovery sweep, and the
    // fire-and-forget immediate post-add) is collection work, isolated from live dashboard reads and
    // sharing only the global in-flight bulkhead.
    const bundle = await mtprotoPost('/qr/collect', {
      body,
      timeoutMs: MTPROTO_TIMEOUT_HEAVY_MS,
      lane: 'background',
    });
    // Cache the (possibly refreshed) identity for the next collect before persisting the bundle.
    if (!ch.username) await persistResolvedIdentity(ch, bundle, uid, gen, accessHash);
    const counts = await persistTgBundle(ch.id, bundle, day);
    return { bundle, channel_daily: counts.channel_daily || 0, posts: counts.posts || 0, velocity: !!counts.velocity };
  }

  // Managed collection of ONE channel (the central channel) through the owner's stored session — the
  // repair path the daily ingest prefers over the (now-revoked) global env TG_SESSION. Unlike
  // collectQrChannelsNow (best-effort, swallows), this one RETHROWS so the caller can fall back to the
  // global live path; every validated prerequisite (crypto, token, decryptable session, known tg id)
  // fails here as a throw. The plaintext session is decrypted only server-side and is sent solely
  // inside the mtprotoPost('/qr/collect') JSON body — never returned, logged, or put on a URL.
  async function collectManagedChannelNow(sess, channel, day) {
    if (!sess || !channel || channel.tg_channel_id == null || !sameUid(channel.owner_uid, sess.uid)) {
      const e = new Error('managed_channel_missing_prereq'); e.code = 'managed_prereq'; throw e;
    }
    if (!tgCrypto.configured() || !MTPROTO_TOKEN) {
      const e = new Error('managed_channel_not_configured'); e.code = 'managed_not_configured'; throw e;
    }
    let sessionStr;
    try { sessionStr = await decryptTgSession(sess); }
    catch { const e = new Error('managed_channel_decrypt_failed'); e.code = 'session_decrypt_failed'; throw e; }
    const theDay = day || new Date().toISOString().slice(0, 10);
    try {
      // Central channel is the ONLY caller that opts into velocity AND cover media — both the up-to-12
      // GetMessageStats velocity fanout and the bounded thumbnail downloads run on the owner's session
      // inside the same /qr/collect. Core metrics stay atomic; media is persisted best-effort after it.
      const out = await collectQrChannel(sessionStr, channel, theDay, sess.uid, sess.session_version, { includeVelocity: true, includeMedia: true });
      // A real, completed attempt for THIS session generation → healthy (generation-guarded).
      await finalizeSessionHealth(sess.uid, sess.session_version, { attempted: true, succeeded: true, authFailed: false, errorCode: null });
      // velocity=true ТОЛЬКО когда реальный available-payload реально записан (persistTgBundleTx),
      // никогда не фабрикуется — daily ingest доверяет этому флагу как факту записи.
      return { bundle: out.bundle, channel_daily: out.channel_daily, posts: out.posts, velocity: !!out.velocity };
    } catch (e) {
      const authFailed = isTgAuthError(e);
      await finalizeSessionHealth(sess.uid, sess.session_version, {
        attempted: true, succeeded: false, authFailed, errorCode: authFailed ? e.code : safeTgErrorCode(e),
      });
      throw e;   // caller falls back to the global live path
    }
  }

  // The resolved entity mtproto returns must be the channel we asked for. Reuse the same identity
  // guard the collect path uses (rawTgChannelId, precision-safe): missing, malformed or mismatched
  // identity is fail-closed — a managed response is never trusted without binding it to the channel.
  function assertManagedEntity(channel, data, logEvent = 'tg_managed_post_stats_identity_mismatch') {
    const entity = data && data.entity;
    const actual = entity && entity.id != null ? rawTgChannelId(entity.id) : null;
    const expected = rawTgChannelId(channel.tg_channel_id);
    if (!actual || !expected || actual !== expected) {
      log('warn', logEvent, { channelId: channel.id, error: 'identity_mismatch' });
      const e = new Error('tg_entity_identity_mismatch'); e.code = 'collect_failed'; throw e;
    }
  }

  // Managed per-post stats for the central channel through the owner's stored session — the live-lane
  // repair path routes/tg.js prefers over the (possibly revoked) global env TG_SESSION. Like
  // collectManagedChannelNow it RETHROWS so the route can fall back to the global live path; every
  // validated prerequisite (crypto, token, decryptable session, known tg id, valid msg id) fails here
  // as a throw. The plaintext session is decrypted only server-side and is sent solely inside the
  // mtprotoPost('/qr/post_stats') JSON body — never returned, logged, or put on a URL. Runs on the
  // LIVE breaker lane (a dashboard read, not background collection) and updates managed session health
  // honestly: success → healthy, a genuine auth failure → reauth_required (that generation only),
  // any other upstream failure → degraded — all via the shared finalizeSessionHealth priority logic.
  async function collectManagedPostStatsNow(sess, channel, msgId) {
    const id = Number(msgId);
    if (!sess || !channel || channel.tg_channel_id == null || !sameUid(channel.owner_uid, sess.uid)
      || !Number.isInteger(id) || id <= 0) {
      const e = new Error('managed_post_stats_missing_prereq'); e.code = 'managed_prereq'; throw e;
    }
    if (!tgCrypto.configured() || !MTPROTO_TOKEN) {
      const e = new Error('managed_post_stats_not_configured'); e.code = 'managed_not_configured'; throw e;
    }
    let sessionStr;
    try { sessionStr = await decryptLiveTgSession(sess); }
    catch { const e = new Error('managed_post_stats_decrypt_failed'); e.code = 'session_decrypt_failed'; throw e; }
    const ref = channel.username || String(channel.tg_channel_id);
    // Warm path: a persisted access_hash (generation-guarded) lets a PRIVATE central channel resolve
    // without a dialog scan; a public/username channel resolves directly. Decimal string, POST body only.
    const accessHash = channel.username ? null : await loadStoredAccessHash(channel, sess.uid, sess.session_version, liveDb);
    const body = { session: sessionStr, channel: ref, msg_id: id };
    if (accessHash != null) body.access_hash = accessHash;
    try {
      // Live lane: a per-post dashboard read must fail into the LIVE circuit, not the background
      // collection lane, and is bounded by the stats-tier timeout (mirrors global /post_stats).
      const data = await mtprotoPost('/qr/post_stats', { body, timeoutMs: MTPROTO_TIMEOUT_STATS_MS, lane: 'live' });
      assertManagedEntity(channel, data);
      if (!channel.username) {
        await persistResolvedIdentity(channel, data, sess.uid, sess.session_version, accessHash, liveDb);
      }
      await finalizeSessionHealth(sess.uid, sess.session_version, { attempted: true, succeeded: true, authFailed: false, errorCode: null }, liveDb);
      // Strip the private entity identity before handing the payload to the route/cache — it is a
      // web↔mtproto detail and must never reach a browser response.
      const { entity, ...payload } = data || {};
      return payload;
    } catch (e) {
      const authFailed = isTgAuthError(e);
      await finalizeSessionHealth(sess.uid, sess.session_version, {
        attempted: true, succeeded: false, authFailed, errorCode: authFailed ? e.code : safeTgErrorCode(e),
      }, liveDb);
      throw e;   // caller falls back to the global live path
    }
  }

  // Immediate best-effort collection for freshly-added channels so the dashboard fills within seconds
  // instead of waiting for the nightly cron. Fire-and-forget; sequential (kind to the user's session's
  // flood limits); never throws to the caller.
  async function collectQrChannelsNow(sess, channels) {
    if (!sess || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
    let sessionStr;
    try { sessionStr = await decryptTgSession(sess); } catch { return; }
    const day = new Date().toISOString().slice(0, 10);
    // Same health semantics as the nightly job: auth-fail short-circuits the remaining channels for
    // this session; a single successful collect wins over any non-auth failure. Каждый вызов
    // collectQrChannel — реальная (стартовавшая) попытка, поэтому здесь нет runJobOnce-skip-ветки.
    let attempted = false, succeeded = false, authFailed = false, lastErrCode = null;
    for (const ch of channels) {
      if (!ch || ch.tg_channel_id == null || !sameUid(ch.owner_uid, sess.uid)) continue;
      attempted = true;
      try { await collectQrChannel(sessionStr, ch, day, sess.uid, sess.session_version); succeeded = true; }
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
  // FloodWait never blocks the others or the critical central ingest. cap = сколько НОВОСТАРТОВАННЫХ
  // каналов трогаем за проход (инъектируется/конфигурируется, а не файловая константа): skipped за
  // день каналы лимит не тратят, поэтому следующий проход бегунка добирает остаток. Возвращает
  // { collected, skipped, failed, capped } — статистику прохода.
  async function processTgQrCollection({ cap = tgQrChannelsPerPass } = {}) {
    const stats = { collected: 0, skipped: 0, failed: 0, capped: false };
    if (!db.enabled || !tgCrypto.configured() || !MTPROTO_TOKEN) return stats;
    const day = new Date().toISOString().slice(0, 10);
    let sessions = [];
    try { sessions = await db.listTgSessions(); }
    catch (e) { log('error', 'tg_qr_list_sessions_failed', { error: e.message }); return stats; }

    let done = 0;
    for (const s of sessions) {
      if (done >= cap) { stats.capped = true; break; }
      let sessionStr;
      try { sessionStr = await decryptTgSession(s); }
      catch { log('error', 'tg_qr_decrypt_failed', { uid: s.uid }); continue; }

      let chans = [];
      try {
        chans = (await db.listChannels({ uid: s.uid })).filter(
          (c) => c.source === 'qr' && c.tg_channel_id != null && sameUid(c.owner_uid, s.uid));
      }
      catch (e) { log('error', 'tg_qr_list_channels_failed', { uid: s.uid, error: e.message }); continue; }

      // Per-session health accounting. A `skipped` idempotent result is NOT an attempt (nothing
      // started); only a collection whose fn actually ran counts. Success wins over non-auth errors,
      // auth-fail short-circuits this user's remaining channels (session-wide invalidation).
      let attempted = false, succeeded = false, authFailed = false, lastErrCode = null;
      for (const ch of chans) {
        if (done >= cap) { stats.capped = true; break; }
        let started = false;
        try {
          const out = await db.runJobOnce('qr_collect', `${ch.id}:${day}`, () => {
            started = true;
            return collectQrChannel(sessionStr, ch, day, s.uid, s.session_version);
          });
          if (out.skipped) { stats.skipped++; continue; }
          done++;
          stats.collected++;
          attempted = true;
          succeeded = true;
        }
        catch (e) {
          if (started) { done++; attempted = true; }
          stats.failed++;
          log('error', 'tg_qr_collect_failed', { channelId: ch.id, error: e.message });
          if (isTgAuthError(e)) { authFailed = true; lastErrCode = e.code; break; }
          lastErrCode = safeTgErrorCode(e);
        }
      }

      await finalizeSessionHealth(s.uid, s.session_version, { attempted, succeeded, authFailed, errorCode: lastErrCode });
    }
    log(stats.capped ? 'warn' : 'info', 'tg_qr_collection_done', { ...stats });
    return stats;
  }

  // Bounded, best-effort cover repair for the central channel through the owner's managed session. The
  // 15-min recovery lane fills tg_post_media for recent archived photo/video posts whose small cover is
  // still missing (a transient/missed daily include_media pass), so the open DB-first thumb proxy serves
  // JPEG instead of 503. Identity is derived ENTIRELY server-side (the central channel, its owner, and
  // that owner's stored session) — nothing here is client-controlled. Unlike the managed collect/post_stats
  // paths this NEVER rethrows: it is a background repair with no live fallback, so a failure only logs a
  // fixed safe code and updates session health. Per-item cover misses are best-effort (the endpoint 200s
  // with fewer covers → success); only a genuine endpoint AUTH failure flips THAT session generation to
  // reauth_required, a transient one to degraded, via the shared finalizeSessionHealth priority. The
  // plaintext session is decrypted only here and sent solely inside the mtprotoPost('/qr/media') body —
  // never returned, logged, or put on a URL. Runs on the BACKGROUND breaker lane (collection work).
  async function repairCentralMedia({ cap = tgMediaRepairPerPass, windowDays = tgMediaRepairWindowDays } = {}) {
    const emptyStats = { attempted: false, requested: 0, filled: 0 };
    if (!db.enabled || !tgCrypto.configured() || !MTPROTO_TOKEN) return emptyStats;
    // Feature-detect the repair-specific DB methods so an older schema/facade simply no-ops.
    if (typeof db.listCentralPostsMissingMedia !== 'function' || typeof db.upsertPostMedia !== 'function'
        || typeof db.runJobOnce !== 'function') return emptyStats;

    const centralId = await db.getOwnerChannelId().catch(() => null);
    if (!centralId) return emptyStats;
    const central = await db.getChannelById(centralId).catch(() => null);
    if (!central || central.tg_channel_id == null || central.owner_uid == null) return emptyStats;
    // Owner-scoped session, derived from the central channel's owner_uid (never client input). A missing/
    // reauth_required/foreign session means we simply skip — repair never touches a global or foreign session.
    const sess = await db.getTgSession(central.owner_uid).catch(() => null);
    if (!sess || !sess.session_enc || sess.connection_state === 'reauth_required' || !sameUid(central.owner_uid, sess.uid)) {
      return emptyStats;
    }

    try {
      // One durable claim per six-hour bucket prevents a genuinely thumbless post from being retried
      // every 15 minutes and collapses overlap during inline→worker topology transitions. A new bucket
      // retries partial misses, so success never suppresses them permanently. The seed rotates the
      // bounded selection between buckets, avoiding head-of-line blocking by the same thumbless ids.
      const bucket = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
      const outcome = await db.runJobOnce('tg_media_repair', `${centralId}:${bucket}`, async () => {
        const stats = { attempted: false, requested: 0, filled: 0 };
        let missing = [];
        try {
          missing = await db.listCentralPostsMissingMedia(
            centralId,
            { limit: cap, windowDays, seed: String(bucket) },
          );
        } catch {
          log('error', 'tg_media_repair_query_failed', { channelId: centralId, error: 'query_failed' });
          return stats;
        }
        const msgIds = missing
          .map((row) => String(row?.post_id || ''))
          .filter((id, index, all) => /^[1-9]\d{0,18}$/.test(id) && all.indexOf(id) === index)
          .slice(0, 16);
        if (!msgIds.length) return stats;
        stats.requested = msgIds.length;

        let sessionStr;
        try { sessionStr = await decryptTgSession(sess); }
        catch {
          log('warn', 'tg_media_repair_decrypt_failed', { channelId: centralId, error: 'session_decrypt_failed' });
          return stats;
        }

        const ref = central.username || String(central.tg_channel_id);
        const accessHash = central.username
          ? null
          : await loadStoredAccessHash(central, sess.uid, sess.session_version);
        const body = { session: sessionStr, channel: ref, msg_ids: msgIds };
        if (accessHash != null) body.access_hash = accessHash;

        stats.attempted = true;
        try {
          const data = await mtprotoPost('/qr/media', {
            body, timeoutMs: MTPROTO_TIMEOUT_STATS_MS, lane: 'background',
          });
          assertManagedEntity(central, data, 'tg_media_repair_identity_mismatch');
          if (!central.username) {
            await persistResolvedIdentity(central, data, sess.uid, sess.session_version, accessHash);
          }
          // Trust only covers for the exact ids requested in this batch. Entity binding alone is not
          // enough: a buggy internal response must not attach another archived post's bytes here.
          const requested = new Set(msgIds);
          const covers = Array.isArray(data?.covers)
            ? data.covers.filter((cover) => cover?.size === 'sm' && requested.has(String(cover.post_id)))
            : [];
          if (covers.length) {
            stats.filled = await db.upsertPostMedia(centralId, covers).catch(() => {
              log('warn', 'tg_post_media_persist_failed', { channelId: centralId, error: 'write_failed' });
              return 0;
            }) || 0;
          }
          await finalizeSessionHealth(sess.uid, sess.session_version, {
            attempted: true, succeeded: true, authFailed: false, errorCode: null,
          });
        } catch (e) {
          const authFailed = isTgAuthError(e);
          await finalizeSessionHealth(sess.uid, sess.session_version, {
            attempted: true, succeeded: false, authFailed,
            errorCode: authFailed ? e.code : safeTgErrorCode(e),
          });
          log('warn', 'tg_media_repair_failed', {
            channelId: centralId, code: authFailed ? e.code : safeTgErrorCode(e),
          });
        }
        log('info', 'tg_media_repair_done', { ...stats });
        return stats;
      });
      return outcome.skipped ? emptyStats : (outcome.result || emptyStats);
    } catch {
      log('error', 'tg_media_repair_job_failed', { channelId: centralId, error: 'job_failed' });
      return emptyStats;
    }
  }

  return { collectQrChannelsNow, collectManagedChannelNow, collectManagedPostStatsNow, processTgQrCollection, repairCentralMedia };
}

module.exports = { createTgQrCollectionJob };
