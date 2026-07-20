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
const { createMsCrypto } = require('./lib/ms_crypto');
const { createMsClient } = require('./lib/msClient');
const { createTgCrypto } = require('./lib/tg_crypto');
const { createNotionCrashClient } = require('./lib/notion_crash');
const { log: defaultLog } = require('./lib/observability');
const { makeResolveChannel, hasWorkspaceRole } = require('./middleware/tenant');
const { createApp } = require('./app');
const { createAuthService } = require('./services/authService');
const { createAiProvider } = require('./infrastructure/aiProvider');
const { createAiChatService } = require('./services/aiChatService');
const { createEmailService } = require('./services/emailService');
const { createAuditService } = require('./services/auditService');
const { createInstagramClient } = require('./infrastructure/instagramClient');
const { createIgUsageGate } = require('./infrastructure/igUsageGate');
const {
  createInstagramCollectionJob,
} = require('./jobs/instagramCollectionJob');
const { createMsCollectionJob } = require('./jobs/msCollectionJob');
const { createMsBackfillEngine } = require('./jobs/msBackfillJob');
const { createMemoryCache } = require('./infrastructure/memoryCache');
const { createPersistenceJob } = require('./jobs/persistenceJob');
const { createTgQrCollectionJob } = require('./jobs/tgQrCollectionJob');
const { createReportScheduleJob } = require('./jobs/reportScheduleJob');
const { createDailyIngestJob } = require('./jobs/dailyIngestJob');
const { createJobTracker } = require('./infrastructure/jobTracker');
const {
  createCollectionRecoveryRunner,
} = require('./infrastructure/collectionRecoveryRunner');
const {
  createOperationalRunner,
} = require('./infrastructure/operationalRunner');

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
      backgroundMaxInFlight: config.telegram.mtprotoBackgroundMaxInFlight,
    });
  const igCrypto =
    overrides.igCrypto || createIgCrypto(config.instagram.tokenKey);
  // МойСклад: свой ключ шифрования токенов (MS_TOKEN_KEY) + единый исходящий GET-клиент
  // (lib/msClient — gzip-заголовок обязателен, один ретрай на 429). Тот же fetchWithTimeout,
  // что у IG/OAuth-путей; токены живут только в заголовке запроса, в логи не попадают.
  const msCrypto =
    overrides.msCrypto || createMsCrypto(config.moysklad.tokenKey);
  const msClient =
    overrides.msClient || createMsClient({ fetchImpl: fetchWithTimeout, log });
  const msFetch = msClient.msFetch;
  const tgCrypto =
    overrides.tgCrypto ||
    createTgCrypto(config.telegram.sessionKey, config.telegram.previousSessionKeys);
  const notionCrash =
    overrides.notionCrash || createNotionCrashClient(config.notion);
  const {
    MTPROTO_TOKEN, MTPROTO_TIMEOUT_STATS_MS, MTPROTO_TIMEOUT_HEAVY_MS, mtprotoFetch, mtprotoPost,
  } = mtprotoClient;

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
    setSessionCookie,
    clearSessionCookie,
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
  const { sendEmail, sendEmailDetailed, emailShell, emailBtn, appBase, escHtml } = emailService;
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
  // Общий app-level usage-gate (numeric-only): оба клиента ОБНОВЛЯЮТ его usage-заголовками, но
  // preflight-тормозит по нему только фоновый collection-клиент (paceOnUsage). probeIntervalMs
  // переиспользует валидированный COLLECTION_RECOVERY_INTERVAL_MS — окно «пробного» вызова следующего
  // recovery-прохода совпадает с его периодом.
  const igUsageGate = createIgUsageGate({ probeIntervalMs: config.runtime.collectionRecoveryIntervalMs });
  const igClient = createInstagramClient({
    db,
    log,
    igCrypto,
    defaultToken: IG_TOKEN,
    inflight: sharedIgInflight,
    usageGate: igUsageGate,
    paceOnUsage: false,   // live: только наблюдает gate, никогда не блокируется/спит
  });
  const { igFetch, refreshIgIfNeeded, IG_GRAPH } = igClient;
  // Дневной IG-сбор для крона — jobs/instagramCollectionJob (processPersistence ниже зовёт его
  // per-account; каждый сбой изолирован внутри job и не касается ответа крона).
  // Фоновый сбор пишет через backgroundDb (малый пул), чтобы дневной фан-аут не занимал коннекты
  // live-путей. Отдельный клиент нужен ВСЕГДА (даже при backgroundDb === db): только он paceOnUsage,
  // чтобы preflight-тормоз по gate никогда не касался live-роутов. Делит с live-клиентом один Graph
  // singleflight Map и один usage-gate — одинаковые одновременные upstream-запросы всё ещё схлопываются.
  const collectionIgClient = createInstagramClient({
    db: backgroundDb,
    log,
    igCrypto,
    defaultToken: IG_TOKEN,
    inflight: sharedIgInflight,
    usageGate: igUsageGate,
    paceOnUsage: true,   // фон: при открытом app-gate реджектит новый полёт до Graph-вызова
  });
  const igCollectionJob = createInstagramCollectionJob({
    db: backgroundDb,
    log,
    igCrypto,
    igFetch: collectionIgClient.igFetch,
    refreshIgIfNeeded: collectionIgClient.refreshIgIfNeeded,
  });
  const collectIgForAccount = igCollectionJob.collectIgForAccount;

  // Дневной сбор МойСклада в архив ms_daily — jobs/msCollectionJob (проход по всем подключённым
  // складам, durable per-day гейты). Пишет через backgroundDb, как IG-сбор; msFetch/msCrypto —
  // те же синглтоны, что у живых роутов (у МС нет отдельного paced-клиента: лимит per-account,
  // а не app-level). Проход едет в collection recovery runner ниже — тот же планировщик/интервал.
  const msCollectionJob = createMsCollectionJob({
    db: backgroundDb,
    msFetch,
    msCrypto,
    log,
  });

  // Чанковый бэкфилл заказов покупателей (ms_orders) + resume/доливка — jobs/msBackfillJob.
  // Один инстанс на процесс: его in-process single-flight и должен быть общим для роута
  // (POST /api/ms/backfill стартует fire-and-forget) и recovery-бегунка (runMsOrdersPass).
  // Пишет через backgroundDb (тяжёлый постраничный прогон не занимает live-коннекты).
  const msBackfillEngine = createMsBackfillEngine({
    db: backgroundDb,
    msFetch,
    msCrypto,
    log,
  });

  // Оркестратор дневного персистенса (сырой TG-снимок, IG-сбор per-account/day под runJobOnce,
  // прунинг, capacity-rollup) — jobs/persistenceJob. Зовётся как отслеживаемый post-response tail;
  // его runIgCollectionPass переиспользует и recovery-бегунок. Всё на backgroundDb.
  const { processPersistence, runIgCollectionPass, runDailyMaintenanceOnce } = createPersistenceJob({
    db: backgroundDb,
    log,
    igCrypto,
    collectIgForAccount,
    usageGate: igUsageGate,
    capacityRollups: config.runtime.capacityRollups,
    igAccountsPerPass: config.runtime.igAccountsPerPass,
    jobsRetentionDays: config.runtime.jobsRetentionDays,
    emailTokensRetentionDays: config.runtime.emailTokensRetentionDays,
    ingestReceiptsRetentionEnabled: config.runtime.ingestReceiptsRetentionEnabled,
    ingestReceiptsRetentionDays: config.runtime.ingestReceiptsRetentionDays,
    auditEventsRetentionEnabled: config.runtime.auditEventsRetentionEnabled,
    auditEventsRetentionDays: config.runtime.auditEventsRetentionDays,
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
  const { collectQrChannelsNow, collectManagedChannelNow, collectManagedPostStatsNow, processTgQrCollection, repairCentralMedia } =
    createTgQrCollectionJob({
      db: backgroundDb,
      liveDb: db,
      log,
      tgCrypto,
      mtprotoPost,
      MTPROTO_TOKEN,
      MTPROTO_TIMEOUT_STATS_MS,
      MTPROTO_TIMEOUT_HEAVY_MS,
      tgPostToRow,
      tgQrChannelsPerPass: config.runtime.tgQrChannelsPerPass,
      tgQrSessionConcurrency: config.runtime.tgQrSessionConcurrency,
      tgMediaRepairPerPass: config.runtime.tgMediaRepairPerPass,
      tgMediaRepairWindowDays: config.runtime.tgMediaRepairWindowDays,
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
    sendEmailDetailed,
    emailShell,
    emailBtn,
    escHtml,
    emailConfigured,
    dispatchConcurrency: config.runtime.reportDispatchConcurrency,
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

  // ── AI-ассистент (STEEP-паттерн) ──────────────────────────────────
  // Провайдер: Anthropic при заданном ключе; БЕЗ ключа — детерминированный mock ВЕЗДЕ, включая
  // production (решение владельца 2026-07-17: обкатка UI до подключения ANTHROPIC_API_KEY).
  // Это безопасно, пока фича superuser-only и mock-ответ сам себя подписывает; ПЕРЕД открытием
  // фичи всем пользователям вернуть `allowMock: !config.isProduction` (прод без ключа → off),
  // иначе реальные пользователи получат заглушку вместо честного 503.
  const aiProvider =
    overrides.aiProvider ||
    createAiProvider({
      apiKey: config.ai.apiKey,
      model: config.ai.model,
      maxOutputTokens: config.ai.maxOutputTokens,
      allowMock: true,
      log,
    });
  const aiChatService = createAiChatService({
    db,
    log,
    provider: aiProvider,
    dailyMessageLimit: config.ai.dailyMessageLimit,
    maxToolRounds: config.ai.maxToolRounds,
    // Складские инструменты ассистента: живой топ товаров и словарь статусов ходят в МС тем же
    // клиентом/шифром, что data-роуты; без MS_TOKEN_KEY/аккаунта инструменты честно отказывают.
    sklad: { msFetch, msCrypto },
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
      setSessionCookie,
      clearSessionCookie,
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
      msCrypto,
      msFetch,
      msBackfill: msBackfillEngine,
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
      collectManagedPostStatsNow,
      TG_TOKEN,
      TG_CHANNEL,
      timingSafeEqualStr,
      dailyIngestJob,
      jobTracker,
      mtprotoClient,
      notionCrash,
      aiChatService,
    });
  }

  // Recovery-бегунок фонового сбора: заводится здесь (инертен до start()); entrypoint стартует его
  // ПОСЛЕ listen (web) или сразу (worker) и гасит в stop() до закрытия пулов. Каждый проход — IG-проход
  // + один TG QR-батч через backgroundDb; item-level runJobOnce делает проходы идемпотентными и
  // добирающими остаток дня. Дорогая maintenance сюда не входит.
  //   enabled завязан и на БД, и на режим: без БД сбор невозможен; в режиме `external` web намеренно НЕ
  //   планирует бегунок (recovery вынесен в отдельный процесс). `inline` (web-в-себе) и `worker`
  //   (standalone) держат бегунок включённым — оба режима исполняются в разных процессах и не
  //   пересекаются (web-entrypoint отвергает worker, worker-entrypoint требует worker).
  const recoveryMode = config.runtime.collectionRecoveryMode;
  const collectionRunner =
    overrides.collectionRunner ||
    createCollectionRecoveryRunner({
      log,
      jobTracker,
      runIgCollectionPass,
      processTgQrCollection,
      repairCentralMedia,
      runMsCollectionPass: msCollectionJob.runMsCollectionPass,
      runMsOrdersPass: msBackfillEngine.runMsOrdersPass,
      igCap: config.runtime.igAccountsPerPass,
      tgCap: config.runtime.tgQrChannelsPerPass,
      mediaCap: config.runtime.tgMediaRepairPerPass,
      mediaWindowDays: config.runtime.tgMediaRepairWindowDays,
      initialDelayMs: config.runtime.collectionRecoveryInitialDelayMs,
      intervalMs: config.runtime.collectionRecoveryIntervalMs,
      enabled: !!backgroundDb.enabled && recoveryMode !== 'external',
    });

  // Operational-бегунок (scheduled-отчёты + дневная maintenance): устраняет единственную внешнюю
  // зависимость от POST /api/ingest/daily. Web-only и НЕ mode-gated (в отличие от collection runner
  // выше): собирается всегда, включён при поднятой БД, стартует только web main.js ПОСЛЕ listen и
  // гасится в stop() до закрытия пулов. Standalone worker строит его инертным, но никогда не стартует.
  // База ссылок — канонический config.http.publicUrl (request-объекта здесь нет).
  const operationalRunner =
    overrides.operationalRunner ||
    createOperationalRunner({
      log,
      jobTracker,
      processReportSchedules,
      runDailyMaintenanceOnce,
      publicUrl: config.http.publicUrl,
      initialDelayMs: config.runtime.operationalRunnerInitialDelayMs,
      intervalMs: config.runtime.operationalRunnerIntervalMs,
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
    operationalRunner,
    collectionRecoveryMode: recoveryMode,
    drainState,
    adapters: Object.freeze({ mtprotoClient, igCrypto, tgCrypto, notionCrash }),
  };
}

module.exports = { createComposition };
