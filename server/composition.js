// ═══════════════════════════════════════════════════════════════
//  Atlavue — Backend Server
//  Node.js + Express
// ═══════════════════════════════════════════════════════════════

'use strict';
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { createDatabase } = require('./db');
const { hashPassword, verifyPassword, rateLimitKey } = require('./lib/auth');
const { captionSnippet } = require('./lib/caption');
const { fetchWithTimeout } = require('./lib/http');
const { createMtprotoClient } = require('./lib/mtproto-client');
const { createIgCrypto } = require('./lib/ig_crypto');
const { createTgCrypto } = require('./lib/tg_crypto');
const { createNotionCrashClient } = require('./lib/notion_crash');
const { log: defaultLog } = require('./lib/observability');
const { makeResolveChannel, hasWorkspaceRole } = require('./middleware/tenant');
const { createApp } = require('./app');
const { createAuthService } = require('./services/authService');
const { createEmailService } = require('./services/emailService');
const { createAuditService } = require('./services/auditService');
const { createInstagramClient } = require('./infrastructure/instagramClient');
const {
  createInstagramCollectionJob,
} = require('./jobs/instagramCollectionJob');
const { createMemoryCache } = require('./infrastructure/memoryCache');
const { createPersistenceJob } = require('./jobs/persistenceJob');
const { createTgQrCollectionJob } = require('./jobs/tgQrCollectionJob');
const { createReportScheduleJob } = require('./jobs/reportScheduleJob');
const { createDailyIngestJob } = require('./jobs/dailyIngestJob');
const { createJobTracker } = require('./infrastructure/jobTracker');
const {
  createCollectionRecoveryRunner,
} = require('./infrastructure/collectionRecoveryRunner');

function createComposition(config, overrides = {}) {
  const log = overrides.log || defaultLog;
  const db = overrides.db || createDatabase(config, overrides.databaseOptions);
  // Отдельный МАЛЫЙ пул для фонового сбора/отчётов/maintenance — тяжёлый хвост не должен занимать
  // коннекты у live HTTP/auth/tenant-путей (они держат основной `db`). Те же конечные DB-deadlines,
  // только `max` меньше (config.database.backgroundPoolMax, дефолт 2).
  //   • явно инъектированный backgroundDb (тесты капасити/shutdown) — берём его;
  //   • инъектирован основной db, но НЕ backgroundDb → переиспользуем его же (не плодим второй
  //     фейковый/реальный пул в тестах с overrides.db);
  //   • иначе (боевой путь) — создаём реальный второй фасад с background-пулом.
  const backgroundDb =
    overrides.backgroundDb ||
    (overrides.db || (overrides.databaseOptions?.core && !overrides.backgroundDatabaseOptions)
      ? db
      : createDatabase(
          { ...config, database: { ...config.database, poolMax: config.database.backgroundPoolMax } },
          overrides.backgroundDatabaseOptions || overrides.databaseOptions,
        ));
  const mtprotoClient =
    overrides.mtprotoClient ||
    createMtprotoClient({
      url: config.telegram.mtprotoUrl,
      token: config.telegram.mtprotoToken,
    });
  const igCrypto =
    overrides.igCrypto || createIgCrypto(config.instagram.tokenKey);
  const tgCrypto =
    overrides.tgCrypto || createTgCrypto(config.telegram.sessionKey);
  const notionCrash =
    overrides.notionCrash || createNotionCrashClient(config.notion);
  const { MTPROTO_TOKEN, MTPROTO_TIMEOUT_STATS_MS, MTPROTO_TIMEOUT_HEAVY_MS, mtprotoFetch, mtprotoPost } =
    mtprotoClient;

  // История (Postgres): dbReady гейтит data-роуты, пока идёт миграция. Сама boot-цепочка
  // (bootPromise) стартует ниже — после создания authService, чьи bootstrapAdmin/
  // claimOwnerChannel она зовёт (destructured const не хойстится, в отличие от прежних
  // function-деклараций).
  let dbReady = false;

  // General read limiter for the authed dashboard (~9 reads per refresh). Keyed PER
  // USER, not per IP: behind Railway's proxy `trust proxy: 1` can resolve req.ip to a
  // shared upstream address, so an IP-keyed limit would be effectively global — one
  // user (or an external probe hitting /api/health etc.) could throttle everyone,
  // surfacing as "Источники недоступны" and login "Слишком много запросов". A signed
  // session token can't be forged and parseToken (defined below) rejects garbage, so
  // keying by uid is safe and token-rotation can't escape it; unauthenticated requests
  // fall back to a per-IP bucket. 600/15min is generous for real dashboard usage.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    keyGenerator: (req) =>
      rateLimitKey(parseToken(req.headers['x-session-token']), req.ip),
    message: { error: 'Слишком много запросов. Попробуй через 15 минут.' },
  });

  // Stricter limiter for auth endpoints (brute-force / enumeration hardening).
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Слишком много попыток входа. Подожди 15 минут.' },
  });

  // ── Авторизация: stateless HMAC-токены (переживают рестарт/редеплой) ──
  // Весь auth-домен — services/authService.js (PR C): секрет + подписанты сессий,
  // requireAuth/requireSuper, бутстрап админа, утилиты auth-флоу (email-токены,
  // DUMMY_HASH). Boot-fatal чек секретов — validateConfig в main.js. composition раздаёт
  // поля сервиса в createApp deps — сам deps-контракт app.js не менялся.
  const authService = createAuthService({ config, db });
  const {
    AUTH_SECRET,
    SESSION_TTL,
    GOOGLE_CLIENT_ID,
    signSession,
    parseToken,
    VERIFY_TTL,
    RESET_TTL,
    sha256,
    newToken,
    DUMMY_HASH,
    bootstrapAdmin,
    claimOwnerChannel,
    requireAuth,
    requireSuper,
  } = authService;

  // Журнал действий — services/auditService.js (IP_HASH_KEY выводится внутри из AUTH_SECRET).
  const { audit } = createAuditService({ db, authSecret: AUTH_SECRET });

  // Поднимаем схему, если БД подключена; после схемы — бутстрап админ-аккаунта, затем
  // привязка central-канала к админу. main.js ждёт bootPromise ДО listen. Цепочка НИКОГДА
  // не reject'ится: сбой БД логируется (db_init_failed), dbReady=false, сервер всё равно
  // поднимается (health 200 / ready 503) — прежнее DB-стойкое поведение.
  let bootPromise = null;
  function boot() {
    if (bootPromise) return bootPromise;
    bootPromise = db
      .init()
      .then(bootstrapAdmin)
      .then(claimOwnerChannel)
      .then(() => {
        dbReady = true;
      })
      .catch((e) => {
        log('error', 'db_init_failed', { error: e.message });
        dbReady = false;
      });
    return bootPromise;
  }

  // ── Channel (tenant) resolution & isolation ──────────────────────
  const resolveChannel = makeResolveChannel({ db, isReady: () => dbReady });

  // ── In-memory кэш — infrastructure/memoryCache (PR E) ────────────
  // Map-подобный интерфейс (size-геттер, clear) — health/DELETE /api/cache как раньше.
  // Свип стартует в main.js ПОСЛЕ listen (cache.start()) и гасится в runtime.stop();
  // createApp и require-only консюмеры (тесты) таймеров не создают, ленивая эвикция
  // на чтении та же. Границы (LRU cap / TTL) — из валидированного config.cache; свип 60с
  // (дефолт фабрики). Инъектированный overrides.memoryCache (тесты) берётся как есть.
  const cache =
    overrides.memoryCache ||
    createMemoryCache({ maxEntries: config.cache.maxEntries, ttlMs: config.cache.ttlMs });
  const jobTracker = overrides.jobTracker || createJobTracker({ log });
  const cacheGet = cache.get;
  const cacheSet = cache.set;

  // Clamp a user-supplied numeric option to the nearest allowed value BEFORE it becomes
  // a cache key — otherwise every distinct value is its own cache miss and a fresh
  // burst of upstream (Graph) calls.
  const nearestOf = (value, allowed) =>
    allowed.reduce((best, v) =>
      Math.abs(v - value) < Math.abs(best - value) ? v : best,
    );

  // ── Email (verification / password reset / reports) — services/emailService ──
  // Resend-отправка, HTML-шаблоны и appBase (публичный origin для ссылок в письмах,
  // anti Host-poisoning c TRUSTED_HOSTS/CANONICAL_ORIGIN) — services/emailService.js.
  // APP_URL warning for production is emitted when the service is composed.
  const emailService = createEmailService({ config });
  const { sendEmail, emailShell, emailBtn, appBase, escHtml } = emailService;
  const emailConfigured = emailService.configured;

  // Constant-time secret compare. Raw `!==` leaks length/prefix timing; timingSafeEqual
  // throws on length mismatch — comparing fixed-length digests avoids both. (Остаётся в
  // composition: единственный потребитель — ingest-гейт.)
  const timingSafeEqualStr = (a, b) =>
    crypto.timingSafeEqual(
      crypto.createHash('sha256').update(String(a)).digest(),
      crypto.createHash('sha256').update(String(b)).digest(),
    );

  // ════════════════════════════════════════════════════════════════
  //  INSTAGRAM ROUTES
  // ════════════════════════════════════════════════════════════════

  // "Instagram API with Instagram Login" (no Facebook Page): the IG user access token works
  // against graph.instagram.com, NOT graph.facebook.com. IG_ACCESS_TOKEN/IG_ACCOUNT_ID is the
  // global single-account fallback; per-channel OAuth tokens (ig_accounts) layer on top and take
  // precedence when a channel has connected its own account (see resolveIg in routes/ig.js).
  // `|| undefined` сохраняет прежнюю undefined-семантику (config дефолтит ''): igFetch
  // default-параметр и все falsy-проверки ведут себя байт-в-байт как при чтении env напрямую.
  const IG_TOKEN = config.instagram.accessToken || undefined;
  const IG_ACCOUNT = config.instagram.accountId || undefined;
  const igMock = require('./ig_mock');
  // Global env single-account is "configured" when both token + account id are present.
  // (The per-channel OAuth connect flow + its app credentials live in routes/ig-oauth.js.)
  const igConfigured = () => !!IG_TOKEN && !!IG_ACCOUNT;

  // Graph-клиент (singleflight igFetch + opportunistic refreshIgIfNeeded) — infrastructure/
  // instagramClient. defaultToken = глобальный env-токен: legacy-вызовы без 3-го аргумента
  // работают как раньше; live-роуты и дневной cron-сбор делят ОДИН клиент.
  const sharedIgInflight = new Map();
  const igClient = createInstagramClient({
    db,
    log,
    igCrypto,
    defaultToken: IG_TOKEN,
    inflight: sharedIgInflight,
  });
  const { igFetch, refreshIgIfNeeded, IG_GRAPH } = igClient;
  // Дневной IG-сбор для крона — jobs/instagramCollectionJob (processPersistence ниже зовёт его
  // per-account; каждый сбой изолирован внутри job и не касается ответа крона).
  // Фоновый сбор пишет через backgroundDb (малый пул), чтобы дневной фан-аут не занимал коннекты
  // live-путей. Отдельный клиент направляет туда и редкий token-refresh, но делит с live-клиентом
  // один Graph singleflight Map — одинаковые одновременные upstream-запросы всё ещё схлопываются.
  const collectionIgClient = backgroundDb === db
    ? igClient
    : createInstagramClient({
        db: backgroundDb,
        log,
        igCrypto,
        defaultToken: IG_TOKEN,
        inflight: sharedIgInflight,
      });
  const igCollectionJob = createInstagramCollectionJob({
    db: backgroundDb,
    log,
    igCrypto,
    igFetch: collectionIgClient.igFetch,
    refreshIgIfNeeded: collectionIgClient.refreshIgIfNeeded,
  });
  const collectIgForAccount = igCollectionJob.collectIgForAccount;

  // Оркестратор дневного персистенса (сырой TG-снимок, IG-сбор per-account/day под runJobOnce,
  // прунинг, capacity-rollup) — jobs/persistenceJob. Зовётся как отслеживаемый post-response tail;
  // его runIgCollectionPass переиспользует и recovery-бегунок. Всё на backgroundDb.
  const { processPersistence, runIgCollectionPass } = createPersistenceJob({
    db: backgroundDb,
    log,
    igCrypto,
    collectIgForAccount,
    capacityRollups: config.runtime.capacityRollups,
    igAccountsPerPass: config.runtime.igAccountsPerPass,
  });

  // One mtproto post ({id,date,views,reactions,forwards,replies,media_type,text,hashtags}) → a
  // posts-table row. Shared by the central ingest and the QR-channel collection so both compute ERV/
  // virality identically.
  function tgPostToRow(p) {
    const reach = p.views || 0;
    const eng = (p.reactions || 0) + (p.forwards || 0) + (p.replies || 0);
    return {
      post_id: p.id,
      date_published: p.date,
      views: p.views || 0,
      reactions: p.reactions || 0,
      forwards: p.forwards || 0,
      replies: p.replies || 0,
      erv: reach > 0 ? (eng / reach) * 100 : null,
      virality: reach > 0 ? ((p.forwards || 0) / reach) * 100 : null,
      media_type: p.media_type,
      caption: captionSnippet(p.text),
      hashtags: p.hashtags || [],
    };
  }

  // Сбор QR-каналов (persistTgBundle/collectQrChannel[sNow]/processTgQrCollection) —
  // jobs/tgQrCollectionJob: сессии дешифруются только внутри, tgPostToRow общий с ingest.
  const { collectQrChannelsNow, collectManagedChannelNow, processTgQrCollection } =
    createTgQrCollectionJob({
      db: backgroundDb,
      log,
      tgCrypto,
      mtprotoPost,
      MTPROTO_TOKEN,
      MTPROTO_TIMEOUT_HEAVY_MS,
      tgPostToRow,
      tgQrChannelsPerPass: config.runtime.tgQrChannelsPerPass,
    });

  // ── Telegram Bot API env — read here; still surfaced by /api/health + the boot banner, and
  // injected into routes/tg.js (which owns the Bot-API fetch helper and the /api/tg/* handlers). ──
  const TG_TOKEN = config.telegram.botToken || undefined; // || undefined — как IG выше
  const TG_CHANNEL = config.telegram.channel || undefined;

  // Email-выгрузка отчётов (weekly/monthly + «Неделя канала» в теле) — jobs/reportScheduleJob;
  // дёргается из ingest-хвостов. weekDigest-движок job требует сам (lib).
  const { processReportSchedules } = createReportScheduleJob({
    db: backgroundDb,
    log,
    sendEmail,
    emailShell,
    emailBtn,
    escHtml,
    emailConfigured,
  });

  // Дневной TG-ingest центрального канала — jobs/dailyIngestJob; роут в app.js оставляет
  // себе токен-гейт и res.json, вся работа дня + формы ответов здесь.
  const dailyIngestJob = createDailyIngestJob({
    db,
    log,
    mtprotoFetch,
    MTPROTO_TIMEOUT_STATS_MS,
    MTPROTO_TIMEOUT_HEAVY_MS,
    tgPostToRow,
    collectManagedChannelNow,
    processReportSchedules,
    processPersistence,
    processTgQrCollection,
  });

  // Флаг дренажа (graceful shutdown): main.js ставит true в stop() → /api/ready 503.
  const drainState = { draining: false };

  // ════════════════════════════════════════════════════════════════
  //  TELEGRAM — Bot API + QR-connect + MTProto proxy routes → routes/tg.js
  // ════════════════════════════════════════════════════════════════

  // Public media proxies (thumb / channel photo) are open <img src> routes, so beyond the global
  // /api limiter they get a dedicated modest per-IP limiter to keep an anonymous scraper from
  // hammering the MTProto service. Defined here with the other rate limiters and injected into the
  // TG routes.
  const mediaLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Слишком много запросов. Попробуй через минуту.' },
  });

  // Единая сборка HTTP-app: все env/БД/таймер-зависимые хелперы построены выше и
  // инъектируются в createApp (server/app.js). getDbReady читает живой флаг миграции dbReady.
  function createHttpApp() {
    return createApp({
      config,
      db,
      log,
      fetchWithTimeout,
      requireAuth,
      requireSuper,
      resolveChannel,
      audit,
      getDbReady: () => dbReady,
      getDraining: () => drainState.draining,
      limiter,
      authLimiter,
      mediaLimiter,
      hashPassword,
      verifyPassword,
      DUMMY_HASH,
      signSession,
      SESSION_TTL,
      GOOGLE_CLIENT_ID,
      appBase,
      sha256,
      newToken,
      VERIFY_TTL,
      RESET_TTL,
      sendEmail,
      emailShell,
      emailBtn,
      escHtml,
      igFetch,
      refreshIgIfNeeded,
      igConfigured,
      igCrypto,
      igMock,
      nearestOf,
      cacheGet,
      cacheSet,
      cache,
      IG_ACCOUNT,
      IG_TOKEN,
      IG_GRAPH,
      AUTH_SECRET,
      tgCrypto,
      collectQrChannelsNow,
      TG_TOKEN,
      TG_CHANNEL,
      timingSafeEqualStr,
      dailyIngestJob,
      jobTracker,
      mtprotoClient,
      notionCrash,
    });
  }

  // Внутрипроцессный recovery-бегунок: заводится здесь (инертен до start()), main.js стартует его
  // ПОСЛЕ listen и гасит в stop() до закрытия пулов. Не работает при выключенной БД. Каждый проход
  // — IG-проход + один TG QR-батч через backgroundDb; item-level runJobOnce делает проходы
  // идемпотентными и добирающими остаток дня. Дорогая maintenance сюда не входит.
  const collectionRunner =
    overrides.collectionRunner ||
    createCollectionRecoveryRunner({
      log,
      jobTracker,
      runIgCollectionPass,
      processTgQrCollection,
      igCap: config.runtime.igAccountsPerPass,
      tgCap: config.runtime.tgQrChannelsPerPass,
      initialDelayMs: config.runtime.collectionRecoveryInitialDelayMs,
      intervalMs: config.runtime.collectionRecoveryIntervalMs,
      enabled: !!backgroundDb.enabled,
    });

  // Реальные пулы, которые обязан закрыть main.js РОВНО по одному разу. Set дедуплицирует случай
  // backgroundDb === db (инъектированный тестовый db переиспользуется как фоновый).
  const databases = Array.from(new Set([db, backgroundDb]));

  // main.js owns process lifecycle; this factory only builds the dependency graph.
  return {
    config,
    db,
    backgroundDb,
    databases,
    boot,
    createHttpApp,
    memoryCache: cache,
    jobTracker,
    collectionRunner,
    drainState,
    adapters: Object.freeze({ mtprotoClient, igCrypto, tgCrypto, notionCrash }),
  };
}

module.exports = { createComposition };
