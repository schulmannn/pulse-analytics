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
    }),
    telegram: Object.freeze({
      botToken: env.TG_BOT_TOKEN || '',
      channel: env.TG_CHANNEL || '',
      ownerChannel: env.OWNER_CHANNEL || env.TG_CHANNEL || '@bynotem',
      mtprotoUrl: env.MTPROTO_URL || '',
      mtprotoToken: env.MTPROTO_TOKEN || '',
      sessionKey: env.TG_SESSION_KEY || '',
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
      // Внутрипроцессный recovery-бегунок: задержка первого прохода после listen и период повторов.
      collectionRecoveryInitialDelayMs: Number(env.COLLECTION_RECOVERY_INITIAL_DELAY_MS || 30000),
      collectionRecoveryIntervalMs: Number(env.COLLECTION_RECOVERY_INTERVAL_MS || 900000),
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
  for (const [field, value] of [
    ['http.port', config.http.port],
    ['database.poolMax', config.database.poolMax],
    ['database.backgroundPoolMax', config.database.backgroundPoolMax],
    ['runtime.webReplicas', config.runtime.webReplicas],
  ]) {
    if (!Number.isInteger(value) || value <= 0) add(field, `${field} должен быть положительным целым числом.`);
  }
  // Возобновляемый сбор: лимиты проходов и тайминги бегунка. Патологические 0/отрицательные
  // значения остановили бы прогресс (cap=0 → ничего не стартует) или зациклили таймер (interval<=0).
  for (const [field, value] of [
    ['runtime.igAccountsPerPass', config.runtime.igAccountsPerPass],
    ['runtime.tgQrChannelsPerPass', config.runtime.tgQrChannelsPerPass],
    ['runtime.collectionRecoveryInitialDelayMs', config.runtime.collectionRecoveryInitialDelayMs],
    ['runtime.collectionRecoveryIntervalMs', config.runtime.collectionRecoveryIntervalMs],
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
  if (config.runtime.webReplicas > 1) {
    add('runtime.webReplicas', 'WEB_REPLICAS > 1 запрещён до появления shared state (ADR-002: одна реплика).');
  }
  if (prod && !/^https:\/\/.+/.test(config.http.publicUrl)) {
    add('http.publicUrl', 'APP_URL должен быть абсолютным https:// URL в production.');
  }
  return errors;
}

module.exports = { loadConfig, validateConfig, ConfigError, parseCsv, normalizeEmail, isProductionEnv };
