'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const databaseModule = require('../server/db');
const { loadConfig } = require('../server/config');

test('db module exports a factory instead of a module-load singleton', () => {
  assert.equal(typeof databaseModule.createDatabase, 'function');
  assert.equal(typeof databaseModule.isDbUnavailable, 'function');
  assert.equal(databaseModule.enabled, undefined);
});

test('createDatabase returns independent facades from independent configs', async () => {
  const first = databaseModule.createDatabase(loadConfig({}));
  const second = databaseModule.createDatabase(loadConfig({}));

  assert.notEqual(first, second);
  assert.equal(first.enabled, false);
  assert.equal(second.enabled, false);
  assert.notEqual(first.runJobOnce, second.runJobOnce);
  await first.close();
  await second.close();
});

test('createDatabase: лимит GDPR-выгрузок зажат под PGPOOL_MAX фасада, а не валит старт', async () => {
  for (const [env, expected] of [
    [{}, 2], // дефолт: пул 10, лимит 2 — как задан
    [{ PGPOOL_MAX: '2' }, 1], // маленький прод-пул: одна выгрузка, второй коннект остаётся API
    [{ PGPOOL_MAX: '1' }, 1], // ниже 1 не опускаемся: 0 = экспорт всегда 503
    [{ GDPR_EXPORT_MAX_CONCURRENT: '4', PGPOOL_MAX: '4' }, 3],
    [{ GDPR_EXPORT_MAX_CONCURRENT: '3', PGPOOL_MAX: '4' }, 3],
  ]) {
    let received;
    const db = databaseModule.createDatabase(loadConfig(env), {
      createGdprService: (deps) => {
        received = deps;
        return {};
      },
    });
    assert.equal(received.exportMaxConcurrent, expected, `${JSON.stringify(env)} → ${expected}`);
    await db.close();
  }
});
