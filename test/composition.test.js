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

function createFakeDb(enabled = false) {
  let initCalls = 0;
  return {
    enabled,
    get initCalls() {
      return initCalls;
    },
    async init() {
      initCalls += 1;
    },
    async close() {},
    async ping() {
      return { enabled, ok: true };
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

test('composition: recovery mode gates the runner (external inert, inline/worker active)', async () => {
  // Фейковый jobTracker перехватывает сабмит прохода, поэтому реальные IG/TG passes не выполняются:
  // единственный наблюдаемый эффект — вызван ли jobTracker.run, т.е. включён ли бегунок в этом режиме.
  const base = { NODE_ENV: 'test', SESSION_SECRET: 'secret' };
  const makeTracker = () => {
    const runs = [];
    return { runs, run: (_task, fields) => { runs.push(fields); return Promise.resolve({ accepted: true }); } };
  };

  const externalTracker = makeTracker();
  const external = createComposition(
    loadConfig({ ...base, COLLECTION_RECOVERY_MODE: 'external' }),
    { db: createFakeDb(true), log: () => {}, jobTracker: externalTracker },
  );
  assert.equal(external.collectionRecoveryMode, 'external');
  assert.deepEqual(
    await external.collectionRunner.runOnce(),
    { skipped: true },
    'external: бегунок инертен даже при включённой БД',
  );
  assert.equal(externalTracker.runs.length, 0, 'external: проход не сабмичен');

  for (const mode of ['inline', 'worker']) {
    const tracker = makeTracker();
    const composition = createComposition(
      loadConfig({ ...base, COLLECTION_RECOVERY_MODE: mode }),
      { db: createFakeDb(true), log: () => {}, jobTracker: tracker },
    );
    assert.equal(composition.collectionRecoveryMode, mode);
    assert.deepEqual(
      await composition.collectionRunner.runOnce(),
      { skipped: false },
      `${mode}: бегунок запускает проход`,
    );
    assert.equal(tracker.runs.length, 1, `${mode}: проход сабмичен через jobTracker`);
  }
});

test('composition: recovery runner stays disabled when the DB is off, regardless of mode', async () => {
  const tracker = { runs: [], run(_t, f) { this.runs.push(f); return Promise.resolve({ accepted: true }); } };
  const composition = createComposition(
    loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'secret', COLLECTION_RECOVERY_MODE: 'inline' }),
    { db: createFakeDb(false), log: () => {}, jobTracker: tracker },
  );
  assert.deepEqual(await composition.collectionRunner.runOnce(), { skipped: true }, 'DB-less: бегунок инертен');
  assert.equal(tracker.runs.length, 0);
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
