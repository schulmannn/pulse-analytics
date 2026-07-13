'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.RAILWAY_ENVIRONMENT = '';
process.env.RAILWAY_PROJECT_ID = '';
process.env.SESSION_SECRET = 'test-session-secret-for-composition';

const { loadConfig } = require('../server/config');
const { createComposition } = require('../server/composition');

function createFakeDb() {
  let initCalls = 0;
  return {
    enabled: false,
    get initCalls() {
      return initCalls;
    },
    async init() {
      initCalls += 1;
    },
    async close() {},
    async ping() {
      return { enabled: false, ok: true };
    },
    isDbUnavailable() {
      return false;
    },
  };
}

test('composition boot is lazy and idempotent', async () => {
  const db = createFakeDb();
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'secret' });
  const composition = createComposition(config, { db, log: () => {} });

  assert.equal(
    db.initCalls,
    0,
    'construction must not initialize the database',
  );
  await Promise.all([composition.boot(), composition.boot()]);
  assert.equal(db.initCalls, 1);
});

test('composition creates isolated apps and applies configured trust proxy', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'secret',
    TRUST_PROXY_HOPS: '7',
  });
  const first = createComposition(config, {
    db: createFakeDb(),
    log: () => {},
  });
  const second = createComposition(config, {
    db: createFakeDb(),
    log: () => {},
  });
  const firstApp = first.createHttpApp();
  const secondApp = second.createHttpApp();

  assert.equal(firstApp.get('trust proxy'), 7);
  assert.notEqual(firstApp, secondApp);
  assert.notEqual(first.memoryCache, second.memoryCache);
  assert.notEqual(first.jobTracker, second.jobTracker);
});

test('composition adapters are derived from each instance config', () => {
  const first = createComposition(
    loadConfig({
      MTPROTO_URL: 'http://first:8001',
      MTPROTO_TOKEN: 'first-token',
      IG_TOKEN_KEY: 'first-ig-key',
      TG_SESSION_KEY: 'first-tg-key',
    }),
    { db: createFakeDb(), log: () => {} },
  );
  const second = createComposition(
    loadConfig({
      MTPROTO_URL: 'http://second:8001',
      MTPROTO_TOKEN: 'second-token',
      IG_TOKEN_KEY: 'second-ig-key',
      TG_SESSION_KEY: 'second-tg-key',
    }),
    { db: createFakeDb(), log: () => {} },
  );

  assert.equal(first.adapters.mtprotoClient.MTPROTO_URL, 'http://first:8001');
  assert.equal(second.adapters.mtprotoClient.MTPROTO_URL, 'http://second:8001');
  assert.throws(() =>
    second.adapters.igCrypto.decrypt(first.adapters.igCrypto.encrypt('token')),
  );
  assert.throws(() =>
    second.adapters.tgCrypto.decrypt(
      first.adapters.tgCrypto.encrypt('session'),
    ),
  );
});
