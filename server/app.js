// ═══════════════════════════════════════════════════════════════
//  Atlavue — Express app factory (createApp)
// ═══════════════════════════════════════════════════════════════
// Синхронная фабрика HTTP-приложения. Собирает Express-app из ИНЪЕКТИРОВАННЫХ
// зависимостей (deps) — НЕ читает переменных окружения, НЕ трогает db.init/listen/таймеры/
// process.on и не создаёт реальных клиентов/таймеров. Всё окружение-, БД- и таймер-
// зависимое строится в composition.js и прокидывается сюда. Благодаря этому
// app можно собрать в тесте без сети/PG/таймеров и вызвать createApp несколько раз.
//
// Порядок middleware и роутов ТОЧНО повторяет прежний module-load порядок index.js —
// это поведение-preserving рефактор (characterization + smoke тесты фиксируют контракт).

'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requestContext } = require('./lib/observability');
const { legacyCspHeader, setAppHeaders, setHtmlSecurityHeaders } = require('./lib/securityHeaders');
const { assetCacheControl } = require('./lib/staticAssets');
const { registerCollectorRoutes } = require('./routes/collector');
const { registerAuthRoutes } = require('./routes/auth');
const { registerReportsRoutes } = require('./routes/reports');
const { registerCampaignsRoutes } = require('./routes/campaigns');
const { registerBugsRoutes } = require('./routes/bugs');
const { registerChannelsRoutes } = require('./routes/channels');
const { registerTgRoutes } = require('./routes/tg');
const { registerMentionsRoutes } = require('./routes/mentions');
const { registerIgOauthRoutes } = require('./routes/ig-oauth');
const { registerIgRoutes } = require('./routes/ig');
const { registerMsRoutes } = require('./routes/moysklad');
const { registerAccountRoutes } = require('./routes/account');
const { registerHistoryRoutes } = require('./routes/history');

// createApp(deps) — собирает и возвращает Express-app. deps несёт всё, что composition.js
// строит из окружения/БД/таймеров: config, db, готовые middleware (requireAuth/…),
// лимитеры, email/IG/TG-хелперы и оркестраторы дневного ingest'а. getDbReady() читает
// живой флаг миграции (composition владеет мутабельным dbReady). Ничего из deps здесь не
// создаётся заново — только применяется к app.
function createApp(deps) {
  const {
    config, db, log,
    fetchWithTimeout,
    requireAuth, requireSuper, resolveChannel, audit, getDbReady, getDraining,
    limiter, authLimiter, mediaLimiter,
    hashPassword, verifyPassword, DUMMY_HASH, signSession, SESSION_TTL, GOOGLE_CLIENT_ID,
    appBase, sha256, newToken, VERIFY_TTL, RESET_TTL, sendEmail, emailShell, emailBtn, escHtml,
    igFetch, refreshIgIfNeeded, igConfigured, igCrypto, igMock, msCrypto, msFetch, nearestOf,
    cacheGet, cacheSet, cache, IG_ACCOUNT, IG_TOKEN, IG_GRAPH, AUTH_SECRET,
    tgCrypto, collectQrChannelsNow, collectManagedPostStatsNow, TG_TOKEN, TG_CHANNEL,
    timingSafeEqualStr, dailyIngestJob, jobTracker, mtprotoClient, notionCrash,
  } = deps;

  const app = express();
  // Railway forwarding chain (confirmed via the proxy diagnostic): the app's socket
  // peer is Railway's internal LB (100.64.0.0/10) and X-Forwarded-For = "client, edge".
  // So the address list (socket → outward) is [LB, edge, client] and we must trust 2
  // hops to land on the real client IP. `trust proxy: 1` returned the shared edge IP
  // (152.x) for everyone → a global rate-limit bucket. NOT `true` (that trusts client-
  // supplied XFF and is spoofable); the fixed count 2 ignores any prefixed fake hops.
  app.set('trust proxy', config.http.trustProxy);

  // ── Middleware ───────────────────────────────────────────────────
  // CORS: дашборд обслуживается тем же origin (Express отдаёт и статику, и API),
  // поэтому кросс-доменный доступ по умолчанию не нужен → не отдаём wildcard ACAO.
  // Для будущих внешних API-клиентов origin'ы можно явно разрешить через
  // CORS_ORIGINS (список через запятую).
  const CORS_ORIGINS = config.http.corsOrigins;
  app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false, credentials: false }));
  // gzip eligible responses (JSON API payloads + the JS/CSS bundle). compression skips responses
  // below its ~1KB threshold and honours a per-response `Cache-Control: no-transform`; it reads
  // Accept-Encoding, so an unsupported client just gets the identity response.
  app.use(compression());
  app.use(requestContext);
  // A rejected promise in an async route otherwise escapes Express 4 entirely and
  // kills the process (unhandled rejection). Wrap handlers whose awaits are not fully
  // inside try/catch; the terminal error middleware (registered last) does the rest.
  const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // JSON body parser — default 100kb. Big-body routes (collector ingest, bug
  // screenshots, avatar upload) carry their own higher-limit parser, so skip them
  // here; otherwise this 100kb parser would reject their large payloads before the
  // route is reached (body-parser no-ops on an already-parsed body, so the
  // route-local limit would never apply).
  const jsonSmall = express.json();
  app.use((req, res, next) => {
    if (req.path === '/api/collector/ingest'
      || req.path === '/api/me/avatar'   // own 1mb parser — a 100KB-400KB data URL is a valid avatar
      || /\/screenshot$/.test(req.path)) return next();
    jsonSmall(req, res, next);
  });
  // ── App shell + strict nonce-CSP ──────────────────────────────────
  // index.html is the only HTML surface that renders collector-snapshot data.
  // A per-request nonce on its inline <script> tags + `script-src 'nonce-…'`
  // (no 'unsafe-inline') means an injected <script> or inline event handler can't
  // execute — closes the snapshot self-XSS class (defence-in-depth on top of the
  // server-side escape/Number coercion). Inline styles stay allowed (style
  // injection isn't code execution); only Google Fonts is external.
  const APP_HTML_PATH = path.join(__dirname, '../public/index.html');
  let APP_HTML = '';
  try { APP_HTML = fs.readFileSync(APP_HTML_PATH, 'utf8'); }
  catch (e) { console.error('[csp] index.html read failed:', e.message); }
  function sendApp(req, res) {
    const nonce = crypto.randomBytes(16).toString('base64');
    let src = APP_HTML;
    if (!src) { try { src = fs.readFileSync(APP_HTML_PATH, 'utf8'); } catch { return res.status(500).end(); } }
    const html = src.split('<script>').join(`<script nonce="${nonce}">`);
    setHtmlSecurityHeaders(req, res, legacyCspHeader(nonce))
       .set('Content-Type', 'text/html; charset=utf-8')
       .send(html);
  }
  // 3F-3 catover: '/' now serves the new Vite/React SPA (wired in the tail below). The
  // legacy nonce-shell is reachable at /legacy as a reversible escape hatch until B2
  // cleanup. Only its /js asset is still served from public/ (public/index.html is no
  // longer routed — the SPA fallback owns '/').
  app.use('/js', express.static(path.join(__dirname, '../public/js')));

  app.use('/api/', limiter);

  // Auth/account entrypoints are isolated in their own route module; session
  // Validation middleware is assembled in composition; here it is injected.
  registerAuthRoutes({
    app,
    express,
    db,
    requireAuth,
    authLimiter,
    asyncHandler,
    hashPassword,
    verifyPassword,
    DUMMY_HASH,
    signSession,
    SESSION_TTL,
    GOOGLE_CLIENT_ID,
    fetchWithTimeout,
    log,
    audit,
    appBase,
    sha256,
    newToken,
    VERIFY_TTL,
    RESET_TTL,
    sendEmail,
    emailShell,
    emailBtn,
    escHtml,
  });

  // Account/admin/prefs/config routes are isolated in routes/account.js (accountLimiter travels with
  // them). Shared helpers (requireSuper, sendEmail/emailShell, audit, GOOGLE_CLIENT_ID) are injected.
  registerAccountRoutes({ app, requireAuth, requireSuper, db, audit, sendEmail, emailShell, GOOGLE_CLIENT_ID });

  // Instagram data routes + the per-request resolveIg middleware are isolated in routes/ig.js.
  // The shared IG data-access (singleflight igFetch + opportunistic refreshIgIfNeeded), the env
  // single-account fallback and igCrypto are built in composition and injected — the daily IG cron uses
  // them too. igMock backs the no-credentials fallback.
  registerIgRoutes({
    app, requireAuth, db, log,
    igFetch, refreshIgIfNeeded, igConfigured, igCrypto, igMock, nearestOf,
    cacheGet, cacheSet, IG_ACCOUNT, IG_TOKEN,
  });

  // Instagram OAuth (per-channel connect) routes are isolated in routes/ig-oauth.js — the
  // signed-state helpers, the connect-config gate, IG cache purge and the token exchange live there.
  registerIgOauthRoutes({
    app, db, requireAuth, audit, log, fetchWithTimeout, asyncHandler,
    appBase, cache, igConfigured, igCrypto, AUTH_SECRET, IG_GRAPH,
    IG_CLIENT_ID: config.instagram.clientId, IG_CLIENT_SECRET: config.instagram.clientSecret,
    oauthMaxInFlight: config.instagram.oauthMaxInFlight,
    oauthAcquireTimeoutMs: config.instagram.oauthAcquireTimeoutMs,
  });

  // Роуты МойСклада (connect по API-токену + summary/top-products) — routes/moysklad.js.
  // msCrypto/msFetch построены в composition (зеркально igCrypto/igFetch); канал data-роуты
  // резолвят тем же заголовком x-channel-id, что IG (см. resolveMs внутри).
  registerMsRoutes({ app, requireAuth, db, msCrypto, msFetch, cacheGet, cacheSet, log });

  registerChannelsRoutes({ app, db, requireAuth, audit, getDbReady });

  // Named report CRUD is isolated in its own route module; the email schedule
  // worker (processReportSchedules) is wired by composition because the daily ingest cron triggers it.
  registerReportsRoutes({ app, db, requireAuth, audit });
  registerCampaignsRoutes({ app, db, requireAuth, audit });

  // Collector protocol is isolated in its own route module. The handler validates
  // and normalizes the envelope before a single transactional DB call.
  registerCollectorRoutes({
    app,
    db,
    express,
    rateLimit,
    isReady: getDbReady,
    requireAuth,
    audit,
    collectorStaleHours: config.runtime.collectorStaleHours,
  });

  registerTgRoutes({
    app, requireAuth, resolveChannel, db, audit, log,
    cacheGet, cacheSet, asyncHandler, tgCrypto, mediaLimiter, fetchWithTimeout,
    collectQrChannelsNow, collectManagedPostStatsNow, TG_TOKEN, TG_CHANNEL, mtprotoClient,
  });

  // Per-channel Telegram mention rules + live brand-search (moved out of routes/tg.js). Narrow deps:
  // it owns GET/PUT /api/tg/mention-settings and the quota-spending GET /api/tg/mtproto/mentions.
  registerMentionsRoutes({
    app, requireAuth, resolveChannel, db, audit, log,
    cacheGet, cacheSet, tgCrypto, mtprotoClient,
  });

  // ════════════════════════════════════════════════════════════════
  //  ОБЩИЕ ROUTES
  // ════════════════════════════════════════════════════════════════

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'pulse-analytics-web',
      uptime: Math.round(process.uptime()),
      cache:  cache.size,
      sessions: 'signed+versioned',
      database_ready: getDbReady(),
      request_id: req.requestId,
      env: {
        ig:  !!IG_TOKEN && !!IG_ACCOUNT,
        tg:  !!TG_TOKEN && !!TG_CHANNEL,
        auth: !!config.auth.sessionSecret
      }
    });
  });

  app.get('/api/ready', async (req, res) => {
    // Дренаж (graceful shutdown, main.js stop()): новые запросы получают 503 сразу —
    // балансировщик снимает инстанс, пока server.close дорабатывает in-flight.
    if (getDraining && getDraining()) return res.status(503).json({ status: 'draining', request_id: req.requestId });
    if (!getDbReady()) return res.status(503).json({ status: 'starting', request_id: req.requestId });
    try {
      const database = await db.ping();
      res.json({ status: 'ready', database, request_id: req.requestId });
    } catch (error) {
      log('error', 'readiness_failed', { request_id: req.requestId, error: error.message });
      res.status(503).json({
        status: 'not_ready',
        database: { enabled: db.enabled, ok: false },
        request_id: req.requestId,
      });
    }
  });

  app.delete('/api/cache', requireAuth, requireSuper, (req, res) => {
    cache.clear();
    res.json({ ok: true, message: 'Кэш сброшен' });
  });

  // ════════════════════════════════════════════════════════════════
  //  ИСТОРИЯ (Postgres) — снэпшоты сверх 3-месячного окна Telegram
  // ════════════════════════════════════════════════════════════════

  // Снимок дня: тянет дневные серии из /graphs (+ посты) и upsert'ит в БД.
  // Защищён отдельным токеном (НЕ командный пароль) — дёргается cron'ом.
  app.post('/api/ingest/daily', asyncHandler(async (req, res) => {
    const token = req.headers['x-ingest-token'];
    if (!config.runtime.ingestToken || typeof token !== 'string' || !token
        || !timingSafeEqualStr(token, config.runtime.ingestToken)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    // Вся работа дня — jobs/dailyIngestJob (идемпотентный тяжёлый MTProto-проход + прежние
    // формы ответов 200/503/500). tails() запускаются ПОСЛЕ res.json, чтобы не задерживать
    // ответ крону, но регистрируются в jobTracker для graceful shutdown.
    const out = await dailyIngestJob.run({ requestId: req.requestId, base: appBase(req) });
    res.status(out.status).json(out.body);
    if (out.tails) {
      jobTracker.run(out.tails, {
        job: 'daily_ingest_tails',
        request_id: req.requestId,
      });
    }
  }));

  // Postgres-backed history reads are isolated in routes/history.js.
  registerHistoryRoutes({ app, requireAuth, resolveChannel, db, log });

  // Bug tracker, crash telemetry and bug attachments are isolated in their own route module.
  registerBugsRoutes({
    app,
    express,
    db,
    rateLimit,
    requireAuth,
    requireSuper,
    fetchWithTimeout,
    AUTH_SECRET,
    commitSha: config.runtime.commitSha,
    githubRepo: config.github.repo,
    githubDispatchToken: config.github.dispatchToken,
    notionCrash,
  });

  // ── Sprint 3F-3 catover: new Vite/React SPA is the primary dashboard, served at '/' ──
  // The dist/ bundle is produced by the Dockerfile.web build stage. CSP is stricter than
  // the legacy shell: the new app has NO inline scripts (JSX auto-escapes), so script-src
  // is plain 'self' — no nonce. The legacy nonce-shell stays at /legacy as a reversible
  // escape hatch until the B2 cleanup (then this becomes the only HTML surface).
  const APP_DIST = path.join(__dirname, '../frontend/dist');
  // Hashed SPA assets at root (/assets/*). Security headers set per response; content-hashed
  // /assets/** get a 1-year immutable cache, unhashed files (index.html, favicon) stay
  // revalidatable — see lib/staticAssets.assetCacheControl.
  app.use((req, res, next) => { setAppHeaders(req, res); next(); },
    express.static(APP_DIST, {
      index: false,
      setHeaders: (res, filePath) => { res.setHeader('Cache-Control', assetCacheControl(filePath)); },
    }));

  // Pre-catover bookmarks under /app → root equivalent (302; temporary during catover).
  app.get(['/app', '/app/*'], (req, res) => {
    const target = req.originalUrl.replace(/^\/app(?=[/?]|$)/, '') || '/';
    const local = target.startsWith('/') ? target : '/' + target;
    // Same-origin only: '//host' (and '/\host') is protocol-relative → open redirect.
    res.redirect(302, /^\/(?!\/|\\)/.test(local) ? local : '/');
  });

  // Legacy nonce-shell — reversible escape hatch, removed in 3F-3 B2 cleanup.
  app.get('/legacy', sendApp);

  // Unknown /api/* → JSON 404. Without this the SPA fallback served index.html with a
  // 200 for any mistyped API path — clients parsed HTML, monitoring saw success.
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'not_found', request_id: req.requestId });
  });

  // SPA fallback: every other (non-/api, non-asset) GET serves the new app shell.
  app.get('*', (req, res) => {
    setAppHeaders(req, res);
    res.sendFile(path.join(APP_DIST, 'index.html'), (err) => { if (err) res.status(404).end(); });
  });

  // Terminal error handler — asyncHandler rejections and next(e) land here. Known
  // upstream failures carry err.status (igFetch → 502, mtprotoFetch flood → 503) and
  // their message is safe to show; anything else is a plain 500 and must NOT leak
  // internals (pg/driver messages) — the client gets a generic shape, the log gets
  // the full error keyed by request id.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const dbUnavailable = status === 500 && db.isDbUnavailable(err);
    const responseStatus = dbUnavailable ? 503 : status;
    log('error', 'unhandled_error', {
      request_id: req.requestId,
      method: req.method,
      path: req.path,
      status: responseStatus,
      error: err && err.message,
      stack: err && err.stack,
    });
    const body = dbUnavailable
      ? { error: 'Сервис временно недоступен, попробуйте позже', request_id: req.requestId }
      : { error: responseStatus === 500 ? 'internal_error' : String((err && err.message) || 'error'), request_id: req.requestId };
    if (err && err.retryAfter != null) {
      res.set('Retry-After', String(err.retryAfter));
      body.retry_after = err.retryAfter;
    }
    res.status(responseStatus).json(body);
  });

  return app;
}

module.exports = { createApp };
