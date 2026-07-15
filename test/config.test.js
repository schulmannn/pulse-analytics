'use strict';

// Юнит-тесты server/config.js (PR B1 декомпозиции index.js). Чистый модуль, без сети/PG.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig, ConfigError, isProductionEnv } = require('../server/config');

test('loadConfig: дефолты из пустого env', () => {
  const c = loadConfig({});
  assert.equal(c.env, 'development');
  assert.equal(c.isProduction, false);
  assert.equal(c.http.port, 3000);
  assert.equal(c.http.trustProxy, 2);
  assert.deepEqual(c.http.corsOrigins, []);
  assert.equal(c.http.publicUrl, 'https://atlavue.app');
  assert.equal(c.database.sslMode, 'auto');
  assert.equal(c.database.poolMax, 10);
  assert.equal(c.database.connectionTimeoutMs, 3000);
  assert.equal(c.database.statementTimeoutMs, 30000);
  assert.equal(c.database.queryTimeoutMs, 35000);
  assert.equal(c.database.allowDbLess, false);
  assert.equal(c.auth.sessionTtlMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(c.email.from, 'Atlavue <onboarding@resend.dev>');
  assert.equal(c.telegram.ownerChannel, '@bynotem');
  assert.equal(c.telegram.sessionKey, '');
  assert.equal(c.notion.token, '');
  assert.equal(c.notion.crashDatabaseId, '');
  assert.equal(c.cache.maxEntries, 2000);
  assert.equal(c.cache.ttlMs, 600000);
  assert.equal(c.runtime.webReplicas, 1);
});

test('loadConfig: значения из env + нормализация', () => {
  const c = loadConfig({
    NODE_ENV: 'production', PORT: '8080', TRUST_PROXY_HOPS: '3', CORS_ORIGINS: 'a.com, b.com ,',
    APP_URL: 'https://x.app/', DATABASE_URL: 'postgres://x', PGPOOL_MAX: '8', ALLOW_DBLESS: 'true',
    SESSION_SECRET: 's3cret', ADMIN_EMAIL: '  Foo@BAR.com ', WEB_REPLICAS: '2', INGEST_TOKEN: 'tok',
    OWNER_CHANNEL: '@owner', TG_SESSION_KEY: 'tg-key', NOTION_TOKEN: 'notion', NOTION_CRASH_DB: 'db-id',
    CACHE_MAX_ENTRIES: '5000', CACHE_TTL_MS: '300000',
  });
  assert.equal(c.http.port, 8080);
  assert.equal(c.http.trustProxy, 3);
  assert.deepEqual(c.http.corsOrigins, ['a.com', 'b.com']);
  assert.equal(c.http.publicUrl, 'https://x.app', 'trailing slash срезан');
  assert.equal(c.database.poolMax, 8);
  assert.equal(c.database.allowDbLess, true);
  assert.equal(loadConfig({ PG_CONNECTION_TIMEOUT_MS: '1500', PG_STATEMENT_TIMEOUT_MS: '20000', PG_QUERY_TIMEOUT_MS: '25000' }).database.connectionTimeoutMs, 1500);
  assert.equal(c.auth.adminEmail, 'foo@bar.com', 'email нормализован (lower+trim)');
  assert.equal(c.runtime.webReplicas, 2);
  assert.equal(c.runtime.ingestToken, 'tok');
  assert.equal(c.telegram.ownerChannel, '@owner');
  assert.equal(c.telegram.sessionKey, 'tg-key');
  assert.equal(c.notion.token, 'notion');
  assert.equal(c.notion.crashDatabaseId, 'db-id');
  assert.equal(c.cache.maxEntries, 5000);
  assert.equal(c.cache.ttlMs, 300000);
});

test('validateConfig: cache cap и TTL должны оставаться в безопасных границах', () => {
  assert.deepEqual(
    validateConfig(loadConfig({ CACHE_MAX_ENTRIES: '10000', CACHE_TTL_MS: '3600000' })),
    [],
  );

  for (const env of [
    { CACHE_MAX_ENTRIES: '99' },
    { CACHE_MAX_ENTRIES: '10001' },
    { CACHE_MAX_ENTRIES: '2.5' },
    { CACHE_TTL_MS: '999' },
    { CACHE_TTL_MS: '3600001' },
    { CACHE_TTL_MS: 'NaN' },
  ]) {
    const errors = validateConfig(loadConfig(env));
    const field = Object.hasOwn(env, 'CACHE_MAX_ENTRIES') ? 'cache.maxEntries' : 'cache.ttlMs';
    assert.ok(errors.some((error) => error.field === field), `${JSON.stringify(env)} отклонён`);
  }
});

test('loadConfig: appUrl — RAW без дефолта (пусто = не задан), с тримом хвостового «/»', () => {
  // Контракт B2c: appBase() в index решает фолбэк сам — config НЕ подставляет atlavue
  // (в отличие от publicUrl, который дефолтит для validateConfig).
  assert.equal(loadConfig({}).http.appUrl, '');
  assert.equal(loadConfig({ APP_URL: 'https://x.app/' }).http.appUrl, 'https://x.app');
  assert.equal(loadConfig({}).http.publicUrl, 'https://atlavue.app', 'publicUrl дефолтит — это ДРУГОЕ поле');
});

test('loadConfig: бывшие route-env (commitSha/staleHours/IG-oauth/GH-dispatch) — деривации как в роутах', () => {
  const d = loadConfig({});
  assert.equal(d.runtime.commitSha, '', 'пусто локально → роут дефолтит dev сам');
  assert.equal(d.runtime.collectorStaleHours, 24, 'дефолт 24ч');
  assert.equal(d.instagram.clientId, '');
  assert.equal(d.github.repo, '');
  const c = loadConfig({
    RAILWAY_GIT_COMMIT_SHA: 'abc1234def', COLLECTOR_STALE_HOURS: '0',
    IG_CLIENT_ID: 'cid', IG_CLIENT_SECRET: 'sec', GITHUB_REPO: 'o/r', GITHUB_DISPATCH_TOKEN: 't',
  });
  assert.equal(c.runtime.commitSha, 'abc1234def');
  // '0' → parseInt 0 (falsy) → ||24 → 24: ТОЧНО как старая формула роута (кламп max(1,…)
  // страхует только отрицательные/дробные <1, не ноль — фиксируем как есть).
  assert.equal(c.runtime.collectorStaleHours, 24);
  assert.equal(loadConfig({ COLLECTOR_STALE_HOURS: '48' }).runtime.collectorStaleHours, 48);
  assert.equal(loadConfig({ COLLECTOR_STALE_HOURS: '-5' }).runtime.collectorStaleHours, 1, 'Math.max(1,…) клампит отрицательные');
  assert.equal(c.instagram.clientId, 'cid');
  assert.equal(c.instagram.clientSecret, 'sec');
  assert.equal(c.github.repo, 'o/r');
  assert.equal(c.github.dispatchToken, 't');
});

test('loadConfig: trustedHosts raw + capacityRollups строго ===\'1\'', () => {
  assert.equal(loadConfig({}).http.trustedHosts, '');
  assert.equal(loadConfig({ TRUSTED_HOSTS: 'a.app, b.app' }).http.trustedHosts, 'a.app, b.app', 'сырая строка — Set строит index');
  assert.equal(loadConfig({}).runtime.capacityRollups, false);
  assert.equal(loadConfig({ CAPACITY_ROLLUPS: '1' }).runtime.capacityRollups, true);
  assert.equal(loadConfig({ CAPACITY_ROLLUPS: 'true' }).runtime.capacityRollups, false, 'только "1" — как старый ===-чек');
});

test('loadConfig: фоновый сбор — дефолты и env-переопределения', () => {
  const d = loadConfig({});
  assert.equal(d.database.backgroundPoolMax, 2, 'малый фоновый пул по умолчанию 2');
  assert.equal(d.runtime.igAccountsPerPass, 25);
  assert.equal(d.runtime.tgQrChannelsPerPass, 200);
  assert.equal(d.runtime.collectionRecoveryInitialDelayMs, 30000);
  assert.equal(d.runtime.collectionRecoveryIntervalMs, 900000);
  const c = loadConfig({
    PGPOOL_BACKGROUND_MAX: '3', IG_ACCOUNTS_PER_PASS: '10', TG_QR_CHANNELS_PER_PASS: '50',
    COLLECTION_RECOVERY_INITIAL_DELAY_MS: '5000', COLLECTION_RECOVERY_INTERVAL_MS: '600000',
  });
  assert.equal(c.database.backgroundPoolMax, 3);
  assert.equal(c.runtime.igAccountsPerPass, 10);
  assert.equal(c.runtime.tgQrChannelsPerPass, 50);
  assert.equal(c.runtime.collectionRecoveryInitialDelayMs, 5000);
  assert.equal(c.runtime.collectionRecoveryIntervalMs, 600000);
});

test('validateConfig: валидные фоновые лимиты → нет ошибок', () => {
  assert.deepEqual(validateConfig(loadConfig({})), []);
  assert.deepEqual(
    validateConfig(loadConfig({
      PGPOOL_BACKGROUND_MAX: '4', IG_ACCOUNTS_PER_PASS: '1', TG_QR_CHANNELS_PER_PASS: '500',
      COLLECTION_RECOVERY_INITIAL_DELAY_MS: '1000', COLLECTION_RECOVERY_INTERVAL_MS: '60000',
    })),
    [],
  );
});

test('validateConfig: патологические 0/отрицательные фоновые лимиты → ошибки', () => {
  const bad = validateConfig(loadConfig({
    PGPOOL_BACKGROUND_MAX: '0', IG_ACCOUNTS_PER_PASS: '0', TG_QR_CHANNELS_PER_PASS: '-1',
    COLLECTION_RECOVERY_INITIAL_DELAY_MS: '0', COLLECTION_RECOVERY_INTERVAL_MS: '-5',
  }));
  assert.ok(bad.some((e) => e.field === 'database.backgroundPoolMax'), 'фоновый пул 0 отклонён');
  assert.ok(bad.some((e) => e.field === 'runtime.igAccountsPerPass'), 'IG cap 0 отклонён');
  assert.ok(bad.some((e) => e.field === 'runtime.tgQrChannelsPerPass'), 'TG cap отрицательный отклонён');
  assert.ok(bad.some((e) => e.field === 'runtime.collectionRecoveryInitialDelayMs'), 'delay 0 отклонён');
  assert.ok(bad.some((e) => e.field === 'runtime.collectionRecoveryIntervalMs'), 'interval отрицательный отклонён');
  // Дробные тоже не целые → отклоняются.
  const frac = validateConfig(loadConfig({ IG_ACCOUNTS_PER_PASS: '2.5' }));
  assert.ok(frac.some((e) => e.field === 'runtime.igAccountsPerPass'), 'дробный cap отклонён');
  const fractionalPool = validateConfig(loadConfig({ PGPOOL_BACKGROUND_MAX: '1.5' }));
  assert.ok(fractionalPool.some((e) => e.field === 'database.backgroundPoolMax'), 'дробный pool max отклонён');
  const tooFast = validateConfig(loadConfig({
    COLLECTION_RECOVERY_INITIAL_DELAY_MS: '999',
    COLLECTION_RECOVERY_INTERVAL_MS: '59999',
  }));
  assert.ok(tooFast.some((e) => e.field === 'runtime.collectionRecoveryInitialDelayMs'), 'sub-second startup storm отклонён');
  assert.ok(tooFast.some((e) => e.field === 'runtime.collectionRecoveryIntervalMs'), 'sub-minute recovery storm отклонён');
});

test('isProductionEnv: NODE_ENV=production ИЛИ Railway-маркер', () => {
  assert.equal(isProductionEnv({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEnv({ RAILWAY_ENVIRONMENT: 'prod' }), true);
  assert.equal(isProductionEnv({ RAILWAY_PROJECT_ID: 'p1' }), true);
  assert.equal(isProductionEnv({ NODE_ENV: 'development' }), false);
  assert.equal(isProductionEnv({}), false);
});

test('loadConfig: результат заморожен (Object.freeze)', () => {
  const c = loadConfig({});
  assert.equal(Object.isFrozen(c), true);
  assert.equal(Object.isFrozen(c.http), true);
  assert.equal(Object.isFrozen(c.cache), true);
  assert.throws(() => { c.http.port = 9999; }, TypeError);
});

test('validateConfig: валидный dev-конфиг → нет ошибок', () => {
  assert.deepEqual(validateConfig(loadConfig({})), []);
});

test('validateConfig: валидный prod-конфиг → нет ошибок', () => {
  const errs = validateConfig(loadConfig({
    NODE_ENV: 'production', SESSION_SECRET: 's', DATABASE_URL: 'postgres://x', APP_URL: 'https://atlavue.app',
  }));
  assert.deepEqual(errs, []);
});

test('validateConfig: prod без SESSION_SECRET → ошибка auth.sessionSecret', () => {
  const errs = validateConfig(loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', APP_URL: 'https://a.app' }));
  assert.ok(errs.some((e) => e.field === 'auth.sessionSecret'));
});

test('validateConfig: prod без DATABASE_URL (и без ALLOW_DBLESS) → ошибка database.url', () => {
  const errs = validateConfig(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 's', APP_URL: 'https://a.app' }));
  assert.ok(errs.some((e) => e.field === 'database.url'));
  const ok = validateConfig(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 's', APP_URL: 'https://a.app', ALLOW_DBLESS: 'true' }));
  assert.ok(!ok.some((e) => e.field === 'database.url'), 'ALLOW_DBLESS снимает требование');
});

test('validateConfig: MTPROTO_URL без MTPROTO_TOKEN → ошибка (в любом env)', () => {
  const errs = validateConfig(loadConfig({ MTPROTO_URL: 'http://mtproto:8001' }));
  assert.ok(errs.some((e) => e.field === 'telegram.mtprotoToken'));
});

test('validateConfig: Notion crash sink требует пару token + database id', () => {
  const tokenOnly = validateConfig(loadConfig({ NOTION_TOKEN: 'token' }));
  assert.ok(tokenOnly.some((error) => error.field === 'notion'));

  const databaseOnly = validateConfig(loadConfig({ NOTION_CRASH_DB: 'db-id' }));
  assert.ok(databaseOnly.some((error) => error.field === 'notion'));

  const complete = validateConfig(loadConfig({ NOTION_TOKEN: 'token', NOTION_CRASH_DB: 'db-id' }));
  assert.ok(!complete.some((error) => error.field === 'notion'));
});

test('validateConfig: webReplicas > 1 → запрет; port<=0 → ошибка', () => {
  const errs = validateConfig(loadConfig({ WEB_REPLICAS: '2', PORT: '0' }));
  assert.ok(errs.some((e) => e.field === 'runtime.webReplicas'));
  assert.ok(errs.some((e) => e.field === 'http.port'));
});

test('validateConfig: pool-таймауты должны быть положительными целыми (мс)', () => {
  assert.deepEqual(
    validateConfig(loadConfig({ PG_CONNECTION_TIMEOUT_MS: '3000', PG_STATEMENT_TIMEOUT_MS: '30000', PG_QUERY_TIMEOUT_MS: '35000' })),
    [],
  );
  const bad = validateConfig(loadConfig({ PG_CONNECTION_TIMEOUT_MS: '0', PG_STATEMENT_TIMEOUT_MS: 'abc', PG_QUERY_TIMEOUT_MS: '-5' }));
  assert.ok(bad.some((e) => e.field === 'database.connectionTimeoutMs'), '0 не положительный');
  assert.ok(bad.some((e) => e.field === 'database.statementTimeoutMs'), 'NaN отклоняется');
  assert.ok(bad.some((e) => e.field === 'database.queryTimeoutMs'), 'отрицательный отклоняется');
  const reversed = validateConfig(loadConfig({ PG_STATEMENT_TIMEOUT_MS: '30000', PG_QUERY_TIMEOUT_MS: '20000' }));
  assert.ok(reversed.some((e) => e.field === 'database.queryTimeoutMs'), 'клиентский timeout должен быть позже серверного');
});

test('validateConfig: trust proxy должен быть целым и неотрицательным', () => {
  const invalid = validateConfig(loadConfig({ TRUST_PROXY_HOPS: 'abc' }));
  assert.ok(invalid.some((error) => error.field === 'http.trustProxy'));

  const negative = validateConfig(loadConfig({ TRUST_PROXY_HOPS: '-1' }));
  assert.ok(negative.some((error) => error.field === 'http.trustProxy'));

  const disabled = validateConfig(loadConfig({ TRUST_PROXY_HOPS: '0' }));
  assert.ok(!disabled.some((error) => error.field === 'http.trustProxy'));
});

test('validateConfig: prod с не-https APP_URL → ошибка http.publicUrl', () => {
  const errs = validateConfig(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 's', DATABASE_URL: 'x', APP_URL: 'http://insecure.app' }));
  assert.ok(errs.some((e) => e.field === 'http.publicUrl'));
});

test('validateConfig: сообщения НЕ содержат значений секретов', () => {
  const secret = 'SUPER-SECRET-VALUE-123';
  const errs = validateConfig(loadConfig({
    NODE_ENV: 'production', SESSION_SECRET: secret, MTPROTO_URL: 'http://m', WEB_REPLICAS: '5', APP_URL: 'http://x',
  }));
  const joined = JSON.stringify(errs) + new ConfigError(errs).message;
  assert.ok(!joined.includes(secret), 'значение секрета не утекает в сообщения ошибок');
});
