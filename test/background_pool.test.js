'use strict';

// Background DB pool wiring + shutdown close semantics. Verifies composition builds a SECOND small
// pool (background collection/report/maintenance) distinct from the live main pool, that an injected
// db is reused (no double pool) unless backgroundDb is explicitly injected, and that main.js closes
// every REAL pool exactly once (deduping the injected-same-db case).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { loadConfig } = require('../server/config');
const { createComposition } = require('../server/composition');
const { main } = require('../server/main');
const { createJobTracker } = require('../server/infrastructure/jobTracker');

class FakePool {
  constructor(options) {
    this.options = options;
    this.ended = 0;
  }
  on() {}
  async query() { return { rows: [] }; }
  async end() { this.ended += 1; }
}

test('composition builds a distinct small background pool alongside the main pool', async () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://x', SESSION_SECRET: 's' });
  const composition = createComposition(config, {
    log: () => {},
    databaseOptions: { poolOptions: { PoolClass: FakePool } },
  });

  assert.notEqual(composition.backgroundDb, composition.db, 'background facade is distinct');
  assert.equal(composition.databases.length, 2, 'two real pools to close');
  assert.equal(composition.db.enabled, true);
  assert.equal(composition.backgroundDb.enabled, true);
  await Promise.all(composition.databases.map((d) => d.close()));
});

test('composition background/main pools carry different max but identical finite deadlines', () => {
  const created = [];
  class RecordingPool extends FakePool {
    constructor(options) { super(options); created.push(options); }
  }
  const config = loadConfig({ DATABASE_URL: 'postgres://x', SESSION_SECRET: 's' });
  createComposition(config, {
    log: () => {},
    databaseOptions: { poolOptions: { PoolClass: RecordingPool } },
  });
  assert.equal(created.length, 2);
  const [mainPool, bgPool] = created;
  assert.equal(mainPool.max, 10, 'live main pool default max');
  assert.equal(bgPool.max, 2, 'background pool default max 2');
  // Same finite DB deadlines on both — background must not relax fail-fast timeouts.
  for (const key of ['connectionTimeoutMillis', 'statement_timeout', 'query_timeout']) {
    assert.equal(bgPool[key], mainPool[key], `${key} identical on both pools`);
  }
});

test('injected db is reused as backgroundDb (no double pool); databases has one entry', () => {
  const fakeDb = { enabled: false, async init() {}, async close() {}, async ping() { return { ok: true }; } };
  const config = loadConfig({ SESSION_SECRET: 's' });
  const composition = createComposition(config, { db: fakeDb, log: () => {} });
  assert.equal(composition.backgroundDb, composition.db, 'injected db reused, no second pool');
  assert.equal(composition.databases.length, 1, 'deduped to a single real pool');
});

test('an explicitly injected core is reused unless separate background options are provided', () => {
  const core = {
    enabled: false,
    pool: null,
    async ping() { return { enabled: false, ok: true }; },
    async close() {},
  };
  const config = loadConfig({ SESSION_SECRET: 's' });
  const composition = createComposition(config, {
    databaseOptions: { core },
    log: () => {},
  });
  assert.equal(composition.backgroundDb, composition.db, 'one injected core is never wrapped twice');
  assert.equal(composition.databases.length, 1, 'shutdown will close the injected core once');
});

test('explicitly injected backgroundDb overrides reuse', () => {
  const fakeDb = { enabled: false, async init() {}, async close() {} };
  const bg = { enabled: false, async init() {}, async close() {} };
  const config = loadConfig({ SESSION_SECRET: 's' });
  const composition = createComposition(config, { db: fakeDb, backgroundDb: bg, log: () => {} });
  assert.equal(composition.backgroundDb, bg);
  assert.equal(composition.databases.length, 2);
});

// ── main.js shutdown closes every real pool exactly once ──────────────────────

function fakeComposition({ databases, extras = {} } = {}) {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return {
    db: databases[0],
    databases,
    memoryCache: { start() {}, stop() {} },
    jobTracker: createJobTracker(),
    drainState: { draining: false },
    async boot() {},
    createHttpApp() { return app; },
    ...extras,
  };
}

test('shutdown closes two DISTINCT pools exactly once each', async () => {
  const a = { ended: 0, async close() { this.ended += 1; } };
  const b = { ended: 0, async close() { this.ended += 1; } };
  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => fakeComposition({ databases: [a, b] }),
    shutdownTimeoutMs: 500,
  });
  await runtime.stop();
  await runtime.stop();   // idempotent
  assert.equal(a.ended, 1, 'main pool closed exactly once');
  assert.equal(b.ended, 1, 'background pool closed exactly once');
});

test('shutdown closes an injected same-db (deduped) exactly once', async () => {
  const shared = { ended: 0, async close() { this.ended += 1; } };
  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    // databases already deduped by composition to a single entry.
    compositionFactory: () => fakeComposition({ databases: [shared] }),
    shutdownTimeoutMs: 500,
  });
  await runtime.stop();
  assert.equal(shared.ended, 1, 'reused db closed exactly once');
});

test('collectionRunner is started after listen and stopped before pools close', async () => {
  const order = [];
  const shared = { ended: 0, async close() { order.push('db.close'); this.ended += 1; } };
  const collectionRunner = {
    start() { order.push('runner.start'); },
    stop() { order.push('runner.stop'); },
  };
  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => fakeComposition({ databases: [shared], extras: { collectionRunner } }),
    shutdownTimeoutMs: 500,
  });
  assert.ok(order.includes('runner.start'), 'runner started after listen');
  await runtime.stop();
  const stopIdx = order.indexOf('runner.stop');
  const closeIdx = order.indexOf('db.close');
  assert.ok(stopIdx >= 0 && closeIdx >= 0 && stopIdx < closeIdx, 'runner stopped before DB close');
});
