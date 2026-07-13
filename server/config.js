'use strict';

/* ── Типизированная конфигурация (декомпозиция index.js, PR B1) ───────────────────────────────────
   ЕДИНСТВЕННОЕ место, где прикладной код преобразует process.env в конфиг. Пока НЕ подключён к boot
   (index.js читает env по-старому) — подключение (index → main.js) в PR B2; здесь модуль + юнит-тесты,
   ноль рантайм-изменений. Деривации ТОЧНО повторяют текущие в index.js (isProduction, дефолты) —
   чтобы swap в B2 был поведение-preserving. validateConfig повторяет существующий boot-fatal-чек
   index.js (SESSION_SECRET/MTPROTO_TOKEN в prod), поэтому в проде проходит (иначе прод уже бы не грузился). */

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
      poolMax: Number(env.PGPOOL_MAX || 4),
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
      mtprotoUrl: env.MTPROTO_URL || '',
      mtprotoToken: env.MTPROTO_TOKEN || '',
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
    runtime: Object.freeze({
      webReplicas: Number(env.WEB_REPLICAS || 1),
      ingestToken: env.INGEST_TOKEN || '',
      capacityRollups: env.CAPACITY_ROLLUPS === '1',
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
  for (const [field, value] of [
    ['http.port', config.http.port],
    ['database.poolMax', config.database.poolMax],
    ['runtime.webReplicas', config.runtime.webReplicas],
  ]) {
    if (!Number.isFinite(value) || value <= 0) add(field, `${field} должен быть положительным числом.`);
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
