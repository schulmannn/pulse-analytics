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
    }),
    telegram: Object.freeze({
      botToken: env.TG_BOT_TOKEN || '',
      channel: env.TG_CHANNEL || '',
      mtprotoUrl: env.MTPROTO_URL || '',
      mtprotoToken: env.MTPROTO_TOKEN || '',
    }),
    email: Object.freeze({
      apiKey: env.RESEND_API_KEY || '',
      from: env.EMAIL_FROM || 'Atlavue <onboarding@resend.dev>',
    }),
    runtime: Object.freeze({
      webReplicas: Number(env.WEB_REPLICAS || 1),
      ingestToken: env.INGEST_TOKEN || '',
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
  if (config.runtime.webReplicas > 1) {
    add('runtime.webReplicas', 'WEB_REPLICAS > 1 запрещён до появления shared state (ADR-002: одна реплика).');
  }
  if (prod && !/^https:\/\/.+/.test(config.http.publicUrl)) {
    add('http.publicUrl', 'APP_URL должен быть абсолютным https:// URL в production.');
  }
  return errors;
}

module.exports = { loadConfig, validateConfig, ConfigError, parseCsv, normalizeEmail, isProductionEnv };
