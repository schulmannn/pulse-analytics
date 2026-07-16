'use strict';

/* Единственное место, где backend преобразует environment variables в runtime config.
   Остальные модули получают замороженный config или узкие значения через DI. */

class ConfigError extends Error {
  constructor(errors) {
    super(`config validation failed: ${errors.map((e) => e.message).join('; ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const parseCsv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const normalizeEmail = (v) => String(v || '').toLowerCase().trim();
// index.js §128: production, если NODE_ENV=production ЛИБО задан любой Railway-маркер.
const isProductionEnv = (env) =>
  env.NODE_ENV === 'production' || !!env.RAILWAY_ENVIRONMENT || !!env.RAILWAY_PROJECT_ID;

function loadConfig(env = process.env) {
  const production = isProductionEnv(env);
  return Object.freeze({
    env: env.NODE_ENV || 'development',
    isProduction: production,
    http: Object.freeze({
      port: Number(env.PORT || 3000),
      trustProxy: Number(env.TRUST_PROXY_HOPS || 2),
      corsOrigins: parseCsv(env.CORS_ORIGINS),
      publicUrl: (env.APP_URL || 'https://atlavue.app').replace(/\/$/, ''),
      // appUrl — RAW (БЕЗ дефолта, только трим хвостового «/»): appBase() в index сам
      // решает фолбэк (TRUSTED_HOSTS → CANONICAL_ORIGIN), пустая строка = «не задан».
      // publicUrl выше — другое поле (с дефолтом) для validateConfig; НЕ путать.
      appUrl: (env.APP_URL || '').replace(/\/$/, ''),
      trustedHosts: env.TRUSTED_HOSTS || '',
    }),
    database: Object.freeze({
      url: env.DATABASE_URL || '',
      sslMode: env.PGSSL || 'auto',
      // Conservative production-safe default: 10 keeps headroom under Postgres/Railway
      // connection caps for one web replica (ADR-002) without over-provisioning idle conns.
      poolMax: Number(env.PGPOOL_MAX || 10),
      // Separate small pool for background collection/report/maintenance jobs so a heavy tail
      // can't starve live HTTP/auth/tenant requests of connections. Default 2: enough for the
      // sequential collection passes without eating into the main pool's headroom.
      backgroundPoolMax: Number(env.PGPOOL_BACKGROUND_MAX || 2),
      // Fail-fast timeouts (мс). Без них пул мог висеть на выдаче коннекта, а зависший
      // запрос — держать соединение бесконечно; db-unavailable→503 маппинг уже есть в db/errors.
      connectionTimeoutMs: Number(env.PG_CONNECTION_TIMEOUT_MS || 3000),
      statementTimeoutMs: Number(env.PG_STATEMENT_TIMEOUT_MS || 30000),
      // queryTimeoutMs держим чуть выше statement_timeout, чтобы серверная отмена сработала
      // первой (внятная ошибка вместо клиентского обрыва).
      queryTimeoutMs: Number(env.PG_QUERY_TIMEOUT_MS || 35000),
      allowDbLess: env.ALLOW_DBLESS === 'true',
    }),
    auth: Object.freeze({
      sessionSecret: env.SESSION_SECRET || '',
      sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
      adminEmail: normalizeEmail(env.ADMIN_EMAIL),
      adminPassword: env.ADMIN_PASSWORD || '',
      googleClientId: env.GOOGLE_CLIENT_ID || '',
    }),
    instagram: Object.freeze({
      accountId: env.IG_ACCOUNT_ID || '',
      accessToken: env.IG_ACCESS_TOKEN || '',
      tokenKey: env.IG_TOKEN_KEY || '',
      // Per-channel OAuth app credentials (IG-Login flow, routes/ig-oauth): без пары
      // клиент/секрет connect-флоу inert — фолбэк на глобальный env-аккаунт или мок.
      clientId: env.IG_CLIENT_ID || '',
      clientSecret: env.IG_CLIENT_SECRET || '',
      // Admission-контроль OAuth-callback: сколько connect-флоу могут ОДНОВРЕМЕННО делать три
      // зависимых внешних обмена (code→short→long→/me) и как коротко ждём слот перед честным
      // fast-fail. Одна web-реплика (ADR-002) → in-memory счётчик авторитетен. Дефолты
      // консервативны: пик онбординга не должен пинать сотни медленных upstream-запросов.
      oauthMaxInFlight: Number(env.IG_OAUTH_MAX_INFLIGHT || 8),
      oauthAcquireTimeoutMs: Number(env.IG_OAUTH_ACQUIRE_TIMEOUT_MS || 2000),
    }),
    telegram: Object.freeze({
      botToken: env.TG_BOT_TOKEN || '',
      channel: env.TG_CHANNEL || '',
      ownerChannel: env.OWNER_CHANNEL || env.TG_CHANNEL || '@bynotem',
      mtprotoUrl: env.MTPROTO_URL || '',
      mtprotoToken: env.MTPROTO_TOKEN || '',
      sessionKey: env.TG_SESSION_KEY || '',
      // Optional key-rotation support: ordered, read-only PREVIOUS session keys tried only when the
      // active TG_SESSION_KEY can't decrypt a stored session. Пусто = [] и прежнее поведение
      // байт-в-байт. Заморожено — потребители получают неизменяемый список.
      previousSessionKeys: Object.freeze(parseCsv(env.TG_SESSION_KEY_PREVIOUS)),
    }),
    github: Object.freeze({
      // repository_dispatch для claude-bugfix (кнопка в баг-трекере); soft-off без пары.
      repo: env.GITHUB_REPO || '',
      dispatchToken: env.GITHUB_DISPATCH_TOKEN || '',
    }),
    email: Object.freeze({
      apiKey: env.RESEND_API_KEY || '',
      from: env.EMAIL_FROM || 'Atlavue <onboarding@resend.dev>',
    }),
    notion: Object.freeze({
      token: env.NOTION_TOKEN || '',
      crashDatabaseId: env.NOTION_CRASH_DB || '',
    }),
    cache: Object.freeze({
      // In-memory response cache (infrastructure/memoryCache) — bounded LRU. maxEntries caps retained
      // responses from the unbounded key space (per-channel × per-param); ttlMs is
      // the ABSOLUTE per-entry deadline (a hot key is promoted, never refreshed). Conservative
      // default cap 2000 (4× прежнего хардкода 500 — не раздуваем память), TTL 10 мин как раньше.
      maxEntries: Number(env.CACHE_MAX_ENTRIES || 2000),
      ttlMs: Number(env.CACHE_TTL_MS || 600000),
    }),
    runtime: Object.freeze({
      webReplicas: Number(env.WEB_REPLICAS || 1),
      ingestToken: env.INGEST_TOKEN || '',
      capacityRollups: env.CAPACITY_ROLLUPS === '1',
      // Возобновляемый фоновый сбор: сколько НОВОСТАРТОВАННЫХ элементов один проход бегунка
      // трогает за раз (уже завершённые за день пропускаются идемпотентно и лимит не тратят,
      // поэтому следующий проход добирает остаток). Консервативные дефолты — не раздуваем
      // upstream fan-out.
      igAccountsPerPass: Number(env.IG_ACCOUNTS_PER_PASS || 25),
      tgQrChannelsPerPass: Number(env.TG_QR_CHANNELS_PER_PASS || 200),
      // Ретеншн операционных строк (ночная maintenance): сколько дней держим ТЕРМИНАЛЬНЫЕ jobs
      // (succeeded/failed, по updated_at) и МЁРТВЫЕ email-токены (consumed/expired, по created_at)
      // перед bounded-прунингом. Консервативно ~месяц; queued/running и валидные неиспользованные
      // токены не трогаются в принципе (предикат, не горизонт).
      jobsRetentionDays: Number(env.JOBS_RETENTION_DAYS || 30),
      emailTokensRetentionDays: Number(env.EMAIL_TOKENS_RETENTION_DAYS || 30),
      // Продуктовый ретеншн (ночная maintenance): ingest_receipts по received_at и audit_events по
      // created_at. Каждый — независимый boolean-флаг (строго '1', как capacityRollups), ВЫКЛЮЧЕН
      // по умолчанию (dark deployment: включит Codex после проверки на проде). Горизонты дефолтят
      // 90/365 и валидируются как прочие retention-поля (положительное целое, ≤ 3650). Флаг OFF =
      // ноль вызовов прунинга (не поддельно высокий TTL); канонические tenant-данные age-TTL не имеют.
      ingestReceiptsRetentionEnabled: env.INGEST_RECEIPTS_RETENTION_ENABLED === '1',
      ingestReceiptsRetentionDays: Number(env.INGEST_RECEIPTS_RETENTION_DAYS || 90),
      auditEventsRetentionEnabled: env.AUDIT_EVENTS_RETENTION_ENABLED === '1',
      auditEventsRetentionDays: Number(env.AUDIT_EVENTS_RETENTION_DAYS || 365),
      // Внутрипроцессный recovery-бегунок: задержка первого прохода после listen и период повторов.
      collectionRecoveryInitialDelayMs: Number(env.COLLECTION_RECOVERY_INITIAL_DELAY_MS || 30000),
      collectionRecoveryIntervalMs: Number(env.COLLECTION_RECOVERY_INTERVAL_MS || 900000),
      // Где исполняется recovery-бегунок фонового сбора. Единый контракт двух Railway-сервисов:
      //   • inline (дефолт, обратно совместимо) — web-процесс планирует бегунок в себе, как раньше;
      //   • external — web НЕ планирует бегунок (recovery вынесен наружу отдельным процессом);
      //   • worker — отдельный standalone-процесс (server/worker.js) владеет бегунком и не поднимает HTTP.
      // Каждый entrypoint дополнительно сужает набор допустимых режимов (web ≠ worker, worker = worker),
      // поэтому web не может случайно стартовать как worker, а worker — молча работать в inline/external.
      collectionRecoveryMode: String(env.COLLECTION_RECOVERY_MODE || 'inline').trim().toLowerCase(),
      // Деплой-метка для crash-телеметрии (Railway её штампует; локально пусто → 'dev' в bugs).
      commitSha: env.RAILWAY_GIT_COMMIT_SHA || env.COMMIT_SHA || '',
      // Порог «коллектор молчит» для /collector-status; деривация как была в роуте.
      collectorStaleHours: Math.max(1, parseInt(env.COLLECTOR_STALE_HOURS, 10) || 24),
    }),
  });
}

// Возвращает массив структурированных ошибок { field, message } (пустой = валиден). main.js (B2)
// бросит new ConfigError(errors), если непусто. Сообщения НЕ содержат значений секретов.
function validateConfig(config) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const prod = config.isProduction;

  if (prod && !config.auth.sessionSecret) {
    add('auth.sessionSecret', 'SESSION_SECRET обязателен в production (подписывает сессии дашборда).');
  }
  if (prod && !config.database.url && !config.database.allowDbLess) {
    add('database.url', 'DATABASE_URL обязателен в production, если не задан ALLOW_DBLESS=true.');
  }
  if (config.telegram.mtprotoUrl && !config.telegram.mtprotoToken) {
    add('telegram.mtprotoToken', 'MTPROTO_TOKEN обязателен, когда задан MTPROTO_URL (аутентифицирует web→mtproto).');
  }
  if (!!config.notion.token !== !!config.notion.crashDatabaseId) {
    add('notion', 'NOTION_TOKEN и NOTION_CRASH_DB должны быть заданы вместе.');
  }
  // Rotation ключей managed-сессии Telegram. Сообщения НИКОГДА не печатают значения ключей — только
  // структурные факты (счётчики/наличие), иначе секрет утечёт в лог валидации.
  const prevSessionKeys = config.telegram.previousSessionKeys;
  if (prevSessionKeys.length > 0) {
    if (!config.telegram.sessionKey) {
      add('telegram.previousSessionKeys', 'TG_SESSION_KEY_PREVIOUS требует активного TG_SESSION_KEY (прежние ключи сами по себе не включают QR).');
    } else if (prevSessionKeys.includes(config.telegram.sessionKey)) {
      add('telegram.previousSessionKeys', 'Активный TG_SESSION_KEY не должен присутствовать в TG_SESSION_KEY_PREVIOUS.');
    }
    if (new Set(prevSessionKeys).size !== prevSessionKeys.length) {
      add('telegram.previousSessionKeys', 'TG_SESSION_KEY_PREVIOUS не должен содержать повторяющиеся ключи.');
    }
    if (prevSessionKeys.length > 3) {
      add('telegram.previousSessionKeys', 'TG_SESSION_KEY_PREVIOUS ограничен 3 прежними ключами.');
    }
  }
  for (const [field, value] of [
    ['http.port', config.http.port],
    ['database.poolMax', config.database.poolMax],
    ['database.backgroundPoolMax', config.database.backgroundPoolMax],
    ['runtime.webReplicas', config.runtime.webReplicas],
  ]) {
    if (!Number.isInteger(value) || value <= 0) add(field, `${field} должен быть положительным целым числом.`);
  }
  for (const [field, value] of [
    ['runtime.jobsRetentionDays', config.runtime.jobsRetentionDays],
    ['runtime.emailTokensRetentionDays', config.runtime.emailTokensRetentionDays],
    ['runtime.ingestReceiptsRetentionDays', config.runtime.ingestReceiptsRetentionDays],
    ['runtime.auditEventsRetentionDays', config.runtime.auditEventsRetentionDays],
  ]) {
    if (Number.isFinite(value) && value > 3650) add(field, `${field} не должен превышать 3650 дней.`);
  }
  // Возобновляемый сбор: лимиты проходов и тайминги бегунка. Патологические 0/отрицательные
  // значения остановили бы прогресс (cap=0 → ничего не стартует) или зациклили таймер (interval<=0).
  for (const [field, value] of [
    ['runtime.igAccountsPerPass', config.runtime.igAccountsPerPass],
    ['runtime.tgQrChannelsPerPass', config.runtime.tgQrChannelsPerPass],
    ['runtime.collectionRecoveryInitialDelayMs', config.runtime.collectionRecoveryInitialDelayMs],
    ['runtime.collectionRecoveryIntervalMs', config.runtime.collectionRecoveryIntervalMs],
    // Горизонты ретеншна: 0/отрицательные снесли бы свежие строки → положительные целые.
    ['runtime.jobsRetentionDays', config.runtime.jobsRetentionDays],
    ['runtime.emailTokensRetentionDays', config.runtime.emailTokensRetentionDays],
    ['runtime.ingestReceiptsRetentionDays', config.runtime.ingestReceiptsRetentionDays],
    ['runtime.auditEventsRetentionDays', config.runtime.auditEventsRetentionDays],
  ]) {
    if (!Number.isInteger(value) || value <= 0) add(field, `${field} должен быть положительным целым числом.`);
  }
  if (
    Number.isInteger(config.runtime.collectionRecoveryInitialDelayMs) &&
    config.runtime.collectionRecoveryInitialDelayMs > 0 &&
    config.runtime.collectionRecoveryInitialDelayMs < 1000
  ) {
    add('runtime.collectionRecoveryInitialDelayMs', 'COLLECTION_RECOVERY_INITIAL_DELAY_MS должен быть не меньше 1000 мс.');
  }
  if (
    Number.isInteger(config.runtime.collectionRecoveryIntervalMs) &&
    config.runtime.collectionRecoveryIntervalMs > 0 &&
    config.runtime.collectionRecoveryIntervalMs < 60_000
  ) {
    add('runtime.collectionRecoveryIntervalMs', 'COLLECTION_RECOVERY_INTERVAL_MS должен быть не меньше 60000 мс.');
  }
  for (const [field, value] of [
    ['database.connectionTimeoutMs', config.database.connectionTimeoutMs],
    ['database.statementTimeoutMs', config.database.statementTimeoutMs],
    ['database.queryTimeoutMs', config.database.queryTimeoutMs],
  ]) {
    if (!Number.isInteger(value) || value <= 0) add(field, `${field} должен быть положительным целым числом (мс).`);
  }
  if (
    Number.isInteger(config.database.statementTimeoutMs) &&
    Number.isInteger(config.database.queryTimeoutMs) &&
    config.database.queryTimeoutMs <= config.database.statementTimeoutMs
  ) {
    add('database.queryTimeoutMs', 'database.queryTimeoutMs должен быть больше database.statementTimeoutMs.');
  }
  if (!Number.isInteger(config.http.trustProxy) || config.http.trustProxy < 0) {
    add('http.trustProxy', 'TRUST_PROXY_HOPS должен быть целым неотрицательным числом.');
  }
  // Кэш-ответов: жёсткие границы. Слишком малый cap бесполезен, слишком большой — риск RSS;
  // TTL вне [1с..1ч] означает либо бесполезный кэш, либо застойные данные.
  if (
    !Number.isInteger(config.cache.maxEntries) ||
    config.cache.maxEntries < 100 ||
    config.cache.maxEntries > 10000
  ) {
    add('cache.maxEntries', 'CACHE_MAX_ENTRIES должен быть целым числом в диапазоне 100..10000.');
  }
  if (
    !Number.isInteger(config.cache.ttlMs) ||
    config.cache.ttlMs < 1000 ||
    config.cache.ttlMs > 3600000
  ) {
    add('cache.ttlMs', 'CACHE_TTL_MS должен быть целым числом (мс) в диапазоне 1000..3600000.');
  }
  // Instagram OAuth admission-контроль. cap вне [1..64] бессмыслен (0 = connect всегда 503, гигантский
  // = нет защиты от пикового fan-out); acquire-таймаут держим в [100мс..10с]: слишком мало = ложные
  // busy под нормальной нагрузкой, слишком много = запрос висит на переполненном контроллере.
  if (
    !Number.isInteger(config.instagram.oauthMaxInFlight) ||
    config.instagram.oauthMaxInFlight < 1 ||
    config.instagram.oauthMaxInFlight > 64
  ) {
    add('instagram.oauthMaxInFlight', 'IG_OAUTH_MAX_INFLIGHT должен быть целым числом в диапазоне 1..64.');
  }
  if (
    !Number.isInteger(config.instagram.oauthAcquireTimeoutMs) ||
    config.instagram.oauthAcquireTimeoutMs < 100 ||
    config.instagram.oauthAcquireTimeoutMs > 10000
  ) {
    add('instagram.oauthAcquireTimeoutMs', 'IG_OAUTH_ACQUIRE_TIMEOUT_MS должен быть целым числом (мс) в диапазоне 100..10000.');
  }
  if (config.runtime.webReplicas > 1) {
    add('runtime.webReplicas', 'WEB_REPLICAS > 1 запрещён до появления shared state (ADR-002: одна реплика).');
  }
  // Режим recovery-бегунка — общий enum для web и worker. Конкретный процесс дополнительно проверяет
  // допустимость режима у своего entrypoint (main.js отвергает worker, worker.js требует worker),
  // но неизвестное значение фатально сразу: тихий типо в COLLECTION_RECOVERY_MODE не должен молча
  // включить дефолтное поведение и оставить сбор в неопределённом состоянии.
  if (!['inline', 'external', 'worker'].includes(config.runtime.collectionRecoveryMode)) {
    add('runtime.collectionRecoveryMode', 'COLLECTION_RECOVERY_MODE должен быть одним из: inline, external, worker.');
  }
  if (prod && !/^https:\/\/.+/.test(config.http.publicUrl)) {
    add('http.publicUrl', 'APP_URL должен быть абсолютным https:// URL в production.');
  }
  return errors;
}

module.exports = { loadConfig, validateConfig, ConfigError, parseCsv, normalizeEmail, isProductionEnv };
