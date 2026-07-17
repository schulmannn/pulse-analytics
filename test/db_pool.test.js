'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool, resolveSsl } = require('../server/db/pool');

class FakePool {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.ended = false;
    FakePool.instances.push(this);
  }

  on(event, listener) {
    this.listeners.set(event, listener);
  }

  async query() {
    return { rows: [] };
  }

  async end() {
    this.ended = true;
  }
}

test('importing pool module does not construct a Postgres pool', () => {
  FakePool.instances.length = 0;
  assert.equal(FakePool.instances.length, 0);
});

test('createPool uses only injected database config', async () => {
  FakePool.instances.length = 0;
  const first = createPool(
    { url: 'postgres://first', sslMode: 'disable', poolMax: 3 },
    { PoolClass: FakePool },
  );
  const second = createPool(
    { url: 'postgres://second', sslMode: 'require', poolMax: 9 },
    { PoolClass: FakePool },
  );

  assert.equal(FakePool.instances.length, 2);
  // Default fail-fast timeouts flow through when not injected (acquisition + statement + query).
  assert.deepEqual(FakePool.instances[0].options, {
    connectionString: 'postgres://first',
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  assert.deepEqual(FakePool.instances[1].options, {
    connectionString: 'postgres://second',
    ssl: { rejectUnauthorized: false },
    max: 9,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  assert.equal((await first.ping()).enabled, true);
  await first.close();
  assert.equal(FakePool.instances[0].ended, true);
  await second.close();
});

test('createPool forwards injected fail-fast timeouts to the pg.Pool', async () => {
  FakePool.instances.length = 0;
  createPool(
    {
      url: 'postgres://timeouts',
      sslMode: 'disable',
      poolMax: 5,
      connectionTimeoutMs: 1500,
      statementTimeoutMs: 20000,
      queryTimeoutMs: 25000,
    },
    { PoolClass: FakePool },
  );
  assert.deepEqual(FakePool.instances[0].options, {
    connectionString: 'postgres://timeouts',
    ssl: false,
    max: 5,
    connectionTimeoutMillis: 1500,
    statement_timeout: 20000,
    query_timeout: 25000,
  });
});

test('DB-less pool is inert and Railway private URLs disable SSL by default', async () => {
  const disabled = createPool({}, { PoolClass: FakePool });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.pool, null);
  assert.deepEqual(await disabled.ping(), { enabled: false, ok: true });
  assert.equal(resolveSsl('postgres://db.railway.internal/pulse'), false);
});

test('resolveSsl: verify-full and external auto validate the server certificate', () => {
  assert.deepEqual(resolveSsl('postgres://external/pulse', 'verify-full'), { rejectUnauthorized: true });
  assert.deepEqual(resolveSsl('postgres://db.railway.internal/pulse', 'verify-full'), { rejectUnauthorized: true });
  assert.deepEqual(resolveSsl('postgres://external/pulse', 'auto'), { rejectUnauthorized: true });
});

test('resolveSsl: Railway auto stays private-plaintext; weaker external modes require explicit opt-in', () => {
  assert.equal(resolveSsl('postgres://db.railway.internal/pulse', 'auto'), false);
  assert.equal(resolveSsl('postgres://external/pulse', 'disable'), false);
  assert.deepEqual(resolveSsl('postgres://external/pulse', 'require'), { rejectUnauthorized: false });
  assert.throws(() => resolveSsl('postgres://external/pulse', 'bogus'), /unsupported Postgres SSL mode/);
});
