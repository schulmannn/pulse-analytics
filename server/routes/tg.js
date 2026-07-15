'use strict';

const { makeServeSnapshot } = require('../middleware/tenant');
const { toPublicQrStatus } = require('../lib/tgSessionStatus');

const TG_BASE = 'https://api.telegram.org/bot';

/**
 * Telegram routes (Bot API `/api/tg/channel`, QR-connect `/api/tg/qr/*`, MTProto proxy
 * `/api/tg/mtproto/*`, the combined `/api/tg/full`, and the public thumb/photo media proxies).
 * Extracted verbatim from index.js — the MTProto proxy client lives in ./lib/mtproto-client and is
 * injected here; every non-media route still passes requireAuth (+ resolveChannel ownership) as before.
 *
 * TG-exclusive helpers travel with the routes: `tgFetch` (Bot API), `notCentral`/`serveSnapshot`
 * (live-vs-snapshot dispatch), and the `tgQr*` QR-login machinery incl. the in-memory `_qrStarts`
 * binding map. Request-time state (db), secrets and shared middleware are injected; `TG_TOKEN`/
 * `TG_CHANNEL` stay defined in index.js (still read by /api/health + the boot banner) and are passed in.
 */
function registerTgRoutes({
  app, requireAuth, resolveChannel, db, audit, log,
  cacheGet, cacheSet, asyncHandler, tgCrypto, mediaLimiter, fetchWithTimeout,
  collectQrChannelsNow, TG_TOKEN, TG_CHANNEL, mtprotoClient,
}) {
  const {
    MTPROTO_URL, MTPROTO_TOKEN, MTPROTO_TIMEOUT_STATS_MS, MTPROTO_TIMEOUT_HEAVY_MS,
    mtprotoFetch, mtprotoPost, sendMtprotoError,
  } = mtprotoClient;
  const serveSnapshot = makeServeSnapshot({ db });

  // Live MTProto exists only for the 'central' channel (the owner's session).
  // Other channels are fed by collectors → their data comes from Postgres, so the
  // live-proxy routes answer with a soft "not live" marker for them.
  function notCentral(req, res) {
    if (req.channel && req.channel.source === 'central') return false;
    res.json({ available: false, source: 'collector', empty: true });
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  //  TELEGRAM — Bot API
  // ════════════════════════════════════════════════════════════════

  async function tgFetch(method, params = {}) {
    const url = new URL(`${TG_BASE}${TG_TOKEN}/${method}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res  = await fetchWithTimeout(url.toString());
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram API: ${json.description}`);
    return json.result;
  }

  app.get('/api/tg/channel', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
    if (await serveSnapshot(req, res, d => d.channel)) return;
    const cacheKey = `tg:channel:${req.channel.id}`;
    try {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      // Основной источник — Bot API (только если задан токен бота)
      if (TG_TOKEN) {
        try {
          const [chat, memberCount] = await Promise.all([
            tgFetch('getChat',            { chat_id: TG_CHANNEL }),
            tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL })
          ]);
          const data = {
            id:          chat.id,
            title:       chat.title,
            username:    chat.username,
            description: chat.description || '',
            memberCount,
            online:      0,
            inviteLink:  chat.invite_link || null,
            source:      'bot_api',
          };
          cacheSet(cacheKey, data);
          return res.json(data);
        } catch (_botErr) {
          // бот недоступен → падаем в MTProto-фолбэк ниже
        }
      }

      // Фолбэк — MTProto через твой личный аккаунт (работает без бота)
      const mt = await mtprotoFetch('/channel');
      const data = {
        id:          mt.id,
        title:       mt.title,
        username:    mt.username,
        description: mt.description || '',
        memberCount: mt.members || 0,
        online:      mt.online || 0,
        inviteLink:  null,
        source:      'mtproto',
      };
      if (req.channel.id && mt.id) {
        // populate tg_channel_id once; провал записи — actionable, логируем вместо тихого глотания
        db.setChannelTgId(req.channel.id, mt.id).catch((e) =>
          log('warn', 'tg_channel_id_persist_failed', { channelId: req.channel.id, error: e.message }));
      }
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      // both sources failed (bot errors fall through to MTProto above) → upstream outage
      sendMtprotoError(res, e);
    }
  }));

  // ════════════════════════════════════════════════════════════════
  //  TELEGRAM — MTProto прокси
  // ════════════════════════════════════════════════════════════════

  // MTProto proxy client (mtprotoFetch / mtprotoPost / sendMtprotoError + breaker + timeouts)
  // lives in ./lib/mtproto-client and is injected into both the TG routes and the ingest cron.

  // ── Telegram QR connect (managed sessions) ───────────────────────────────
  // «Scan → done» via MTProto QR login on the Telethon service. The session string it
  // returns is encrypted (TG_SESSION_KEY) and stored server-side; it is NEVER sent to the
  // browser. Configured only when the mtproto link + encryption key + DB are all present.
  function tgQrConfigured() {
    return !!MTPROTO_TOKEN && tgCrypto.configured() && db.enabled;
  }

  // A replacement login fixes the credential immediately, so refresh already tracked QR channels
  // immediately as well. Otherwise the connection warning disappears but the dashboard can remain
  // stale until the next daily ingest. This is best-effort and runs after the login response path;
  // existing channels/history are reused, never recreated.
  async function refreshTrackedQrChannels(user) {
    const [session, channels] = await Promise.all([
      db.getTgSession(user.uid),
      db.listChannels(user),
    ]);
    // Refresh the managed central channel too (source='central'), not just source='qr' — a reconnect
    // must actually restore central collection through the fresh session, not merely change the copy.
    // Collector channels are fed by their own agent, and rows without a known tg id can't be collected.
    const tracked = channels.filter(
      (channel) => channel.owner_uid === user.uid
        && (channel.source === 'qr' || channel.source === 'central')
        && channel.tg_channel_id != null);
    if (session && tracked.length) await collectQrChannelsNow(session, tracked);
  }

  // On a completed login: encrypt + persist the session, then hand the browser only the
  // username + the admin channels found (never the session itself).
  async function tgQrFinish(req, data) {
    const session_enc = tgCrypto.encrypt(data.session);
    await db.saveTgSession(req.user.uid, { tg_user_id: data.tg_user_id, username: data.username, session_enc });
    audit(req, 'tg.session.connected', { username: data.username || null }).catch(() => {});
    refreshTrackedQrChannels(req.user).catch((e) =>
      log('error', 'tg_qr_reconnect_refresh_failed', { uid: req.user.uid, error: e.message }));
    return {
      status: 'ok',
      username: data.username ?? null,
      channels: (Array.isArray(data.channels) ? data.channels : []).map((c) => ({
        id: c.id, title: c.title || '', username: c.username ?? null,
        broadcast: c.broadcast ?? undefined, megagroup: c.megagroup ?? undefined,
        creator: c.creator ?? undefined, participants: c.participants ?? null,
        eligible: c.eligible ?? undefined,
      })),
    };
  }

  // Status incl. non-secret connection-health (connection_state + last_attempt/success/error). The
  // shape is built by the pure toPublicQrStatus mapper (unit-tested) — session_enc NEVER leaves here.
  // Is the caller the owner of the managed central channel? Derived ENTIRELY server-side from the
  // central channel's owner_uid (never client input) so the honest owner-only repair signal can't be
  // spoofed. Safe/false whenever the DB is off or the central channel isn't resolvable yet.
  async function isCentralOwner(uid) {
    if (!db.enabled || uid == null) return false;
    try {
      const centralId = await db.getOwnerChannelId();
      if (!centralId) return false;
      const central = await db.getChannelById(centralId);
      return !!(central && central.owner_uid === uid);
    } catch { return false; }
  }

  app.get('/api/tg/qr/status', requireAuth, async (req, res, next) => {
    try {
      const serverReady = tgQrConfigured();
      const [s, centralOwner] = await Promise.all([
        serverReady ? db.getTgSession(req.user.uid) : Promise.resolve(null),
        isCentralOwner(req.user.uid),
      ]);
      res.json(toPublicQrStatus(s, { serverReady, centralOwner }));
    } catch (e) { next(e); }
  });

  // Bind each QR login id to the uid that started it — a leaked/guessed id must never let
  // another account claim the captured session. In-memory (single web instance) with a TTL; a
  // lost binding (server restart) just makes the client's poll read 'expired' and start fresh.
  const _qrStarts = new Map(); // id -> { uid, at }
  const _QR_START_TTL_MS = 5 * 60 * 1000;
  function _qrOwns(id, uid) {
    const o = _qrStarts.get(id);
    return !!o && o.uid === uid;
  }

  app.post('/api/tg/qr/start', requireAuth, async (req, res, next) => {
    if (!tgQrConfigured()) return res.status(400).json({ error: 'Подключение Telegram по QR не настроено на сервере' });
    try {
      const now = Date.now();
      for (const [k, v] of _qrStarts) if (now - v.at > _QR_START_TTL_MS) _qrStarts.delete(k);
      // One live login per user: cancel any prior pending start before opening a new one.
      for (const [k, v] of _qrStarts) {
        if (v.uid === req.user.uid) {
          _qrStarts.delete(k);
          mtprotoPost('/qr/cancel', { params: { id: k } }).catch(() => {});
        }
      }
      const data = await mtprotoPost('/qr/start', {
        timeoutMs: MTPROTO_TIMEOUT_STATS_MS,
        retryConnectionErrors: true,
      });
      _qrStarts.set(data.id, { uid: req.user.uid, at: now });
      res.json({ id: data.id, url: data.url, expires_in: data.expires_in });
    } catch (e) { next(e); }
  });

  app.post('/api/tg/qr/poll', requireAuth, async (req, res, next) => {
    if (!tgQrConfigured()) return res.status(400).json({ error: 'not_configured' });
    const id = String((req.body && req.body.id) || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!_qrOwns(id, req.user.uid)) return res.json({ status: 'expired' });   // not this user's login
    try {
      const data = await mtprotoPost('/qr/poll', { params: { id } });
      if (data.status === 'ok') { _qrStarts.delete(id); return res.json(await tgQrFinish(req, data)); }
      if (data.status === 'expired' || data.status === 'error') _qrStarts.delete(id);
      res.json({ status: data.status, error: data.error });   // pending | password | expired | error
    } catch (e) { next(e); }
  });

  app.post('/api/tg/qr/password', requireAuth, async (req, res, next) => {
    if (!tgQrConfigured()) return res.status(400).json({ error: 'not_configured' });
    const id = String((req.body && req.body.id) || '');
    const password = String((req.body && req.body.password) || '');
    if (!id || !password) return res.status(400).json({ error: 'id and password required' });
    if (!_qrOwns(id, req.user.uid)) return res.json({ status: 'expired' });
    try {
      const data = await mtprotoPost('/qr/password', { params: { id }, body: { password } });
      if (data.status === 'ok') { _qrStarts.delete(id); return res.json(await tgQrFinish(req, data)); }
      res.json({ status: data.status, error: data.error });
    } catch (e) { next(e); }
  });

  // Proactively tear down an abandoned pending login (browser navigates away / gives up), so the
  // ephemeral Telethon client is reclaimed immediately instead of waiting for the mtproto GC.
  app.post('/api/tg/qr/cancel', requireAuth, async (req, res, next) => {
    const id = String((req.body && req.body.id) || '');
    if (!id || !_qrOwns(id, req.user.uid)) return res.json({ ok: true });
    _qrStarts.delete(id);
    try { await mtprotoPost('/qr/cancel', { params: { id } }); } catch { /* best-effort */ }
    res.json({ ok: true });
  });

  app.delete('/api/tg/qr/session', requireAuth, async (req, res, next) => {
    try {
      const ok = await db.deleteTgSession(req.user.uid);
      if (ok) audit(req, 'tg.session.revoked', {}).catch(() => {});
      res.json({ ok });
    } catch (e) { next(e); }
  });

  // Persist the admin channels the user ticked as trackable tenants (source='qr'). The list is supplied
  // by the browser (the just-scanned admin channels). We can't re-verify admin rights here yet — that
  // needs a session-based re-listing (P2.2) — but every row is HARD-scoped to owner_uid=req.user.uid
  // and is only ever WRITTEN by THAT user's own captured session, so a crafted/ineligible id creates
  // an empty self-owned row Telegram refuses to hand stats for (no cross-tenant WRITE reach).
  // NOTE (tenancy isolation audit, F1): write-scoping alone is NOT enough — a crafted id also binds
  // this row to the claimed external source (ensureChannelCanonical), and Phase-B canonical READS
  // union by source_id. Cross-tenant READ reach is closed in db.js (sameTenantSource bounds the source
  // union to the reader's own workspace), NOT here; do not relax that on the assumption this row is
  // harmless. Deduped against the user's existing channels (central + already-added) by tg id AND
  // @username; idempotent. The daily cron (P2.3) does the actual collection.
  app.post('/api/tg/qr/channels', requireAuth, async (req, res, next) => {
    if (!db.enabled) return res.status(400).json({ error: 'База данных выключена' });
    try {
      const sess = await db.getTgSession(req.user.uid);
      if (!sess) return res.status(400).json({ error: 'Сначала подключите Telegram по QR' });
      const raw = req.body && Array.isArray(req.body.channels) ? req.body.channels : null;
      if (!raw || !raw.length) return res.status(400).json({ error: 'Не выбрано ни одного канала' });
      if (raw.length > 100) return res.status(400).json({ error: 'Слишком много каналов за раз' });

      // Dedup against ALL of the user's channels (central + any already tracked). listChannels hides
      // disabled rows, so a re-added disabled channel falls through to createTgChannel and reactivates.
      const mine = await db.listChannels(req.user);
      const haveTgIds = new Set(mine.map((c) => (c.tg_channel_id == null ? '' : String(c.tg_channel_id))).filter(Boolean));
      const haveUnames = new Set(mine.map((c) => (c.username ? String(c.username).replace(/^@/, '').toLowerCase() : '')).filter(Boolean));

      let added = 0, skipped = 0;
      const created = [];
      for (const c of raw) {
        const tgId = Number(c && c.id);
        if (!Number.isInteger(tgId) || tgId <= 0) { skipped++; continue; }
        const uname = String((c && c.username) || '').replace(/^@/, '').trim();
        const title = String((c && c.title) || '').slice(0, 200);
        if (haveTgIds.has(String(tgId)) || (uname && haveUnames.has(uname.toLowerCase()))) { skipped++; continue; }
        const row = await db.createTgChannel({
          owner_uid: req.user.uid, tg_channel_id: tgId, username: uname || null, title: title || null,
        });
        if (row) { added++; created.push(row); } else skipped++;
      }
      audit(req, 'tg.qr.channels_added', { added, skipped }).catch(() => {});
      res.json({ ok: true, added, skipped });

      // Fill the just-added channels now, so the dashboard shows data within seconds instead of waiting
      // for the nightly cron. Fire-and-forget AFTER the response — collection latency never blocks it.
      if (created.length) {
        collectQrChannelsNow(sess, created).catch((e) =>
          log('error', 'tg_qr_collect_now_batch_failed', { error: e.message }));
      }
    } catch (e) { next(e); }
  });

  app.get('/api/tg/mtproto/health', requireAuth, async (req, res) => {
    try {
      const data = await mtprotoFetch('/health');
      res.json({ available: true, ...data });
    } catch (e) {
      res.json({ available: false, error: e.message });
    }
  });

  app.get('/api/tg/mtproto/channel', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
    if (await serveSnapshot(req, res, d => d.channel)) return;
    const cacheKey = `mtproto:channel:${req.channel.id}`;
    try {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const data = await mtprotoFetch('/channel');
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      sendMtprotoError(res, e);
    }
  }));

  app.get('/api/tg/mtproto/posts', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
    if (await serveSnapshot(req, res, d => ({ posts: d.posts || [], count: (d.posts || []).length }))) return;
    const limit     = Math.min(100, parseInt(req.query.limit)     || 30);
    const offsetId  = parseInt(req.query.offset_id) || 0;
    // Кэшируем только первую страницу: offset_id — произвольный message id с неограниченным
    // ключевым пространством, и один юзер листанием вымывал общий 500-словный кэш (эвикция
    // по порядку вставки), выселяя горячие записи других арендаторов (noisy-neighbor).
    const cacheKey  = offsetId === 0 ? `mtproto:posts:${req.channel.id}:${limit}` : null;
    try {
      const cached = cacheKey && cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const data = await mtprotoFetch('/posts', { limit, offset_id: offsetId });
      if (cacheKey) cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      sendMtprotoError(res, e);
    }
  }));

  app.get('/api/tg/mtproto/views_summary', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
    if (await serveSnapshot(req, res, d => d.views_summary)) return;
    const limit    = Math.min(100, parseInt(req.query.limit) || 30);
    const cacheKey = `mtproto:views:${req.channel.id}:${limit}`;
    try {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const data = await mtprotoFetch('/views_summary', { limit }, MTPROTO_TIMEOUT_STATS_MS);
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      sendMtprotoError(res, e);
    }
  }));

  app.get('/api/tg/mtproto/stats', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
    if (await serveSnapshot(req, res, d => d.stats)) return;
    const cacheKey = `mtproto:stats:${req.channel.id}`;
    try {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const data = await mtprotoFetch('/stats', {}, MTPROTO_TIMEOUT_STATS_MS);
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      // Сюда попадаем только при РЕАЛЬНОМ сбое (MTProto-сервис недоступен): кейс
      // «нет статистики у мелкого канала» Python отдаёт как 200 {available:false}
      // и оно проходит насквозь. Поэтому здесь честный 503 для мониторинга.
      sendMtprotoError(res, e);
    }
  }));

  app.get('/api/tg/mtproto/graphs', requireAuth, resolveChannel, asyncHandler(async (req, res) => {
    if (await serveSnapshot(req, res, d => d.graphs)) return;
    const cacheKey = `mtproto:graphs:${req.channel.id}`;
    try {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const data = await mtprotoFetch('/graphs', {}, MTPROTO_TIMEOUT_HEAVY_MS);
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      sendMtprotoError(res, e);
    }
  }));

  // Velocity сервится из Postgres-снапшота (его строит ingest-крон), поэтому в
  // пользовательском запросе НЕТ тяжёлых последовательных вызовов Telegram.
  // Live-расчёт остаётся только fallback'ом: первый запуск до первого крона или
  // режим без БД — тогда считаем на лету один раз и кэшируем.
  app.get('/api/tg/mtproto/velocity', requireAuth, resolveChannel, async (req, res) => {
    const cacheKey = `mtproto:velocity:${req.channel.id}`;
    try {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);

      if (db.enabled && req.channel.id) {
        const snap = await db.getLatestVelocityForActor(req.channel.id, req.user).catch(() => null);
        if (snap && snap.data) {
          const out = { ...snap.data, source: 'db', computed_at: snap.computed_at };
          cacheSet(cacheKey, out);
          return res.json(out);
        }
      }

      // нет снапшота (до первого крона) → live-расчёт ТОЛЬКО для central-канала
      // (у остальных данные приходят коллектором в Postgres).
      if (req.channel.source !== 'central') return res.json({ available: false, source: 'collector', empty: true });
      const data = await mtprotoFetch('/velocity', {}, MTPROTO_TIMEOUT_HEAVY_MS);
      if (data && data.available) {
        data.source = 'live';
        cacheSet(cacheKey, data);   // не кэшируем неуспех
      }
      res.json(data);
    } catch (e) {
      sendMtprotoError(res, e);
    }
  });

  // Brand mentions live-search + per-channel mention rules moved to routes/mentions.js
  // (GET/PUT /api/tg/mention-settings + GET /api/tg/mtproto/mentions). The old central-only global
  // legacy-session route is gone: search now runs through the caller's managed QR session with
  // per-channel rules, so it can serve any administered channel without mixing quota/archive identity.

  app.get('/api/tg/mtproto/post_stats/:id', requireAuth, resolveChannel, async (req, res) => {
    if (notCentral(req, res)) return;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const cacheKey = `mtproto:poststats:${req.channel.id}:${id}`;
    try {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const data = await mtprotoFetch('/post_stats/' + id, {}, MTPROTO_TIMEOUT_STATS_MS);
      cacheSet(cacheKey, data);
      res.json(data);
    } catch (e) {
      sendMtprotoError(res, e);
    }
  });

  // ── Public media proxies (thumb / channel photo) ─────────────────────────────
  // Deliberately unauthenticated: they back plain <img src> tags, which can't send
  // the x-session-token header. Tradeoff accepted because the central channel is
  // public anyway (the proxy only reveals what t.me already shows); revisit with
  // signed URLs if private channels ever land. Beyond the global /api limiter
  // (per-IP for anonymous traffic), a dedicated modest per-IP limiter keeps an
  // anonymous scraper from hammering the MTProto service through these routes.

  // Post thumbnail (binary) — open route so <img src> works without a header.
  // Low sensitivity: only serves thumbnails of the configured (public) channel.
  app.get('/api/tg/mtproto/thumb/:id', mediaLimiter, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).end();
    const size = req.query.size === 'lg' ? 'lg' : 'sm';
    try {
      const r = await fetchWithTimeout(`${MTPROTO_URL}/thumb/${id}?size=${size}`, { headers: { 'x-internal-token': MTPROTO_TOKEN } });
      if (!r.ok) {
        if (r.status >= 500) return res.status(503).json({ error: 'источник недоступен' });
        return res.status(r.status).end();
      }
      const buf = await r.buffer();
      res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch (e) {
      res.status(503).json({ error: 'источник недоступен' });
    }
  });

  // Channel avatar (binary) — open route so <img src> works without a header.
  // Low sensitivity: only the configured (public, 'central') channel's profile photo.
  app.get('/api/tg/mtproto/channel/photo', mediaLimiter, async (req, res) => {
    try {
      const r = await fetchWithTimeout(`${MTPROTO_URL}/channel/photo`, { headers: { 'x-internal-token': MTPROTO_TOKEN } });
      if (!r.ok) {
        if (r.status >= 500) return res.status(503).json({ error: 'источник недоступен' });
        return res.status(r.status).end();
      }
      const buf = await r.buffer();
      res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch (e) {
      res.status(503).json({ error: 'источник недоступен' });
    }
  });

  app.get('/api/tg/full', requireAuth, resolveChannel, asyncHandler(async (req, res, next) => {
    if (req.channel && req.channel.source !== 'central') {   // collector channel → from snapshot
      const snap = req.channel.id ? await db.getSnapshotForActor(req.channel.id, req.user).catch(() => null) : null;
      const d = (snap && snap.data) || {};
      return res.json({ channel: d.channel || {}, views_summary: d.views_summary || null, posts: d.posts || [], mtproto_available: !!d.channel, source: 'collector' });
    }
    // Central: prefer the managed snapshot the daily ingest now persists through the owner's session
    // (actor-gated). It carries `source: 'managed'` to distinguish it from a collector snapshot. Only
    // when no managed snapshot exists do we fall back to the old live global MTProto branch below.
    if (db.enabled && req.channel?.id) {
      const snap = await db.getSnapshotForActor(req.channel.id, req.user).catch(() => null);
      const d = snap && snap.data;
      if (d && d.channel && Object.keys(d.channel).length > 0) {
        return res.json({ channel: d.channel, views_summary: d.views_summary || null, posts: d.posts || [], mtproto_available: true, source: 'managed' });
      }
    }
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    try {
      // Posts are persisted by the daily ingest. Prefer that fast, tenant-gated archive in the
      // request path; only a brand-new/empty channel needs a live Telethon read. Previously the
      // live /posts call used the 12s default timeout and Promise.allSettled silently turned its
      // rejection into `posts: []`, so a transient timeout looked like a genuinely empty channel.
      let archivedPosts = [];
      if (db.enabled && req.channel?.id) {
        archivedPosts = await db.listPostsForActor(req.channel.id, req.user, limit).catch((error) => {
          log('warn', 'tg_posts_archive_read_failed', {
            channel_id: req.channel.id,
            error: error.message,
          });
          return [];
        });
      }
      const postsPromise = archivedPosts.length > 0
        ? Promise.resolve({ posts: archivedPosts, source: 'db' })
        : mtprotoFetch('/posts', { limit }, MTPROTO_TIMEOUT_STATS_MS);

      const [botChannel, mtChannel, viewsSummary, posts] = await Promise.allSettled([
        (async () => {
          const [chat, count] = await Promise.all([
            tgFetch('getChat',            { chat_id: TG_CHANNEL }),
            tgFetch('getChatMemberCount', { chat_id: TG_CHANNEL }),
          ]);
          return { title: chat.title, username: chat.username, description: chat.description || '', memberCount: count };
        })(),
        mtprotoFetch('/channel'),
        mtprotoFetch('/views_summary', { limit }, MTPROTO_TIMEOUT_STATS_MS),
        postsPromise,
      ]);

      const bot  = botChannel.status  === 'fulfilled' ? botChannel.value  : null;
      const mtp  = mtChannel.status   === 'fulfilled' ? mtChannel.value   : null;
      const vs   = viewsSummary.status=== 'fulfilled' ? viewsSummary.value: null;
      const ps   = posts.status       === 'fulfilled' ? posts.value       : null;

      res.json({
        channel: {
          ...(bot || {}),
          ...(mtp || {}),
          memberCount: bot?.memberCount || mtp?.members || 0,
          source: mtp ? 'mtproto+bot_api' : 'bot_api',
        },
        views_summary:   vs,
        posts:           ps?.posts || [],
        posts_source:    ps?.source || (posts.status === 'fulfilled' ? 'live' : null),
        mtproto_available: !!mtp,
        errors: {
          bot:    botChannel.status  === 'rejected' ? botChannel.reason?.message  : null,
          mtp:    mtChannel.status   === 'rejected' ? mtChannel.reason?.message   : null,
          views:  viewsSummary.status=== 'rejected' ? viewsSummary.reason?.message: null,
          posts:  posts.status       === 'rejected' ? posts.reason?.message       : null,
        }
      });
    } catch (e) {
      next(e);
    }
  }));
}

module.exports = { registerTgRoutes };
