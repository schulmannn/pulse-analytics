'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { main } = require('../server/main');
const { ConfigError } = require('../server/config');
const { createJobTracker } = require('../server/infrastructure/jobTracker');

test('invalid production config fails before composition is imported', async () => {
  const compositionPath = require.resolve('../server/composition');
  delete require.cache[compositionPath];
  const originalError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(
      main({ env: { NODE_ENV: 'production' } }),
      ConfigError,
    );
    assert.equal(require.cache[compositionPath], undefined);
  } finally {
    console.error = originalError;
  }
});

test('web entrypoint refuses COLLECTION_RECOVERY_MODE=worker (cannot accidentally start as worker)', async () => {
  // Web-процесс в worker-режиме отвергается ДО построения composition: composition не импортируется,
  // HTTP не поднимается. Это парная защита к worker.js, требующему mode=worker.
  const compositionPath = require.resolve('../server/composition');
  delete require.cache[compositionPath];
  let compositionBuilt = false;
  await assert.rejects(
    main({
      env: { NODE_ENV: 'test', COLLECTION_RECOVERY_MODE: 'worker' },
      port: 0,
      compositionFactory: () => {
        compositionBuilt = true;
        return {};
      },
    }),
    /worker/i,
  );
  assert.equal(compositionBuilt, false, 'composition-фабрика не вызвана для worker-режима на web');
});

test('runtime removes signal listeners and drains tracked tails before DB close', async () => {
  const tracker = createJobTracker();
  const events = [];
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const composition = {
    db: {
      async close() {
        events.push('db.close');
      },
    },
    memoryCache: {
      start() {
        events.push('cache.start');
      },
      stop() {
        events.push('cache.stop');
      },
    },
    jobTracker: tracker,
    drainState: { draining: false },
    async boot() {
      events.push('boot');
    },
    createHttpApp() {
      events.push('createHttpApp');
      return app;
    },
  };

  const termBefore = process.listenerCount('SIGTERM');
  const intBefore = process.listenerCount('SIGINT');
  const uncaughtBefore = process.listenerCount('uncaughtException');
  const unhandledBefore = process.listenerCount('unhandledRejection');
  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => composition,
    shutdownTimeoutMs: 1_000,
  });

  assert.deepEqual(events.slice(0, 3), [
    'boot',
    'createHttpApp',
    'cache.start',
  ]);
  assert.equal(process.listenerCount('SIGTERM'), termBefore + 1);
  assert.equal(process.listenerCount('SIGINT'), intBefore + 1);
  // Fatal-runtime handlers are installed alongside the production-style signal handlers.
  assert.equal(process.listenerCount('uncaughtException'), uncaughtBefore + 1);
  assert.equal(process.listenerCount('unhandledRejection'), unhandledBefore + 1);

  let finishTail;
  tracker.run(
    () =>
      new Promise((resolve) => {
        finishTail = resolve;
      }),
  );
  await Promise.resolve();
  const stopping = runtime.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(composition.drainState.draining, true);
  assert.equal(events.includes('db.close'), false);
  finishTail();
  await stopping;

  assert.deepEqual(events.slice(-2), ['cache.stop', 'db.close']);
  assert.equal(process.listenerCount('SIGTERM'), termBefore);
  assert.equal(process.listenerCount('SIGINT'), intBefore);
  // Fatal handlers are removed symmetrically during stop().
  assert.equal(process.listenerCount('uncaughtException'), uncaughtBefore);
  assert.equal(process.listenerCount('unhandledRejection'), unhandledBefore);

  await runtime.stop();
  assert.equal(events.filter((event) => event === 'db.close').length, 1);
});

test('applies explicit HTTP server timeouts after listen and keeps server.timeout at 0 for streamed responses', async () => {
  const http = require('node:http');
  const events = [];
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const composition = {
    db: { async close() { events.push('db.close'); } },
    memoryCache: { start() {}, stop() {} },
    jobTracker: createJobTracker(),
    drainState: { draining: false },
    async boot() {},
    createHttpApp() { return app; },
  };

  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => composition,
    shutdownTimeoutMs: 1_000,
  });

  // Реальный http.Server с явными таймаутами ровно из config (дефолты 65000/66000/300000).
  assert.ok(runtime.server instanceof http.Server, 'возвращается настоящий http.Server');
  assert.equal(runtime.server.keepAliveTimeout, runtime.config.http.keepAliveTimeoutMs);
  assert.equal(runtime.server.keepAliveTimeout, 65000);
  assert.equal(runtime.server.headersTimeout, runtime.config.http.headersTimeoutMs);
  assert.equal(runtime.server.headersTimeout, 66000);
  assert.equal(runtime.server.requestTimeout, runtime.config.http.requestTimeoutMs);
  assert.equal(runtime.server.requestTimeout, 300000);
  // server.timeout остаётся 0 — нет тайм-аута простоя in-flight сокета, стриминговый ответ жив.
  assert.equal(runtime.server.timeout, 0, 'server.timeout не выставлялся (остаётся 0)');
  assert.equal(runtime.server.listenerCount('timeout'), 0, 'слушатель timeout не добавлялся');
  // keepAlive строго больше 60с Railway-прокси, headers строго больше keepAlive (инвариант Node).
  assert.ok(runtime.server.keepAliveTimeout > 60000);
  assert.ok(runtime.server.headersTimeout > runtime.server.keepAliveTimeout);

  await runtime.stop();
  process.exitCode = 0;
});

test('a slow streamed response stays alive past a short interval (server.timeout stays 0)', async () => {
  const http = require('node:http');
  const app = express();
  // Стримит тело чанками с паузами — совокупно дольше короткого интервала, но без единой длинной
  // синхронной паузы (не флейки). Если бы кто-то выставил server.timeout, сокет бы оборвался.
  app.get('/slow-stream', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let n = 0;
    const tick = () => {
      if (n >= 6) { res.end('done'); return; }
      res.write(`chunk-${n}\n`);
      n += 1;
      setTimeout(tick, 30);
    };
    tick();
  });
  const composition = {
    db: { async close() {} },
    memoryCache: { start() {}, stop() {} },
    jobTracker: createJobTracker(),
    drainState: { draining: false },
    async boot() {},
    createHttpApp() { return app; },
  };

  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => composition,
    shutdownTimeoutMs: 2_000,
  });

  const boundPort = runtime.server.address().port;
  const body = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: boundPort, path: '/slow-stream' }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });

  assert.match(body, /chunk-0/, 'первый чанк получен');
  assert.match(body, /done$/, 'стриминговый ответ дожил до конца, не оборван таймаутом');
  assert.equal(runtime.server.timeout, 0, 'server.timeout всё ещё 0');

  await runtime.stop();
  process.exitCode = 0;
});

test('operational runner starts after listen and stops before DB close (alongside collection runner)', async () => {
  const events = [];
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const composition = {
    db: { async close() { events.push('db.close'); } },
    memoryCache: { start() { events.push('cache.start'); }, stop() { events.push('cache.stop'); } },
    jobTracker: createJobTracker(),
    drainState: { draining: false },
    collectionRunner: { start() { events.push('collection.start'); }, stop() { events.push('collection.stop'); } },
    operationalRunner: { start() { events.push('operational.start'); }, stop() { events.push('operational.stop'); } },
    async boot() { events.push('boot'); },
    createHttpApp() { return app; },
  };

  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => composition,
    shutdownTimeoutMs: 1_000,
  });

  // Both runners start after listen (cache.start precedes them in main.js).
  assert.ok(events.indexOf('cache.start') < events.indexOf('operational.start'), 'operational стартует после listen/cache.start');
  assert.ok(events.includes('collection.start'));
  assert.ok(events.includes('operational.start'));

  await runtime.stop();

  // Both runners stop before DB close.
  assert.ok(events.indexOf('operational.stop') < events.indexOf('db.close'), 'operational гасится до закрытия пулов');
  assert.ok(events.indexOf('collection.stop') < events.indexOf('db.close'));
  assert.deepEqual(events.slice(-2), ['cache.stop', 'db.close']);

  process.exitCode = 0;
});

// Minimal lifecycle composition: real HTTP server (port 0) + injectable db.close so a test can make
// the drain path hang. No signal handlers (installSignalHandlers:false) — the fatal handler is driven
// directly via runtime.handleFatal with an injected `exit`, so nothing can terminate the test runner.
function fatalComposition({ dbClose } = {}) {
  const events = [];
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const composition = {
    db: {
      close: dbClose || (async () => { events.push('db.close'); }),
    },
    memoryCache: { start() { events.push('cache.start'); }, stop() { events.push('cache.stop'); } },
    jobTracker: createJobTracker(),
    drainState: { draining: false },
    async boot() { events.push('boot'); },
    createHttpApp() { return app; },
  };
  return { composition, events };
}

test('fatal fault drains once and exits 1 (single-flight)', async () => {
  const { composition, events } = fatalComposition();
  const exits = [];
  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
    exit: (code) => exits.push(code),
  });

  const firstFatal = runtime.handleFatal('uncaughtException', new Error('boom'));
  const simultaneousFatal = runtime.handleFatal('unhandledRejection', new Error('second'));
  assert.strictEqual(simultaneousFatal, firstFatal, 'concurrent fatal faults share one drain');
  await firstFatal;
  assert.equal(process.exitCode, 1, 'non-zero outcome set');
  assert.equal(composition.drainState.draining, true, 'stopped accepting traffic / drained');
  assert.ok(events.includes('db.close'), 'graceful stop() ran to db close');
  assert.deepEqual(exits, [1], 'exit(1) exactly once after graceful drain');

  // Single-flight: a second fault while/after handling does not drain or exit again.
  await runtime.handleFatal('unhandledRejection', new Error('second'));
  assert.deepEqual(exits, [1], 'second fault is a no-op (single-flight)');
  assert.equal(events.filter((e) => e === 'db.close').length, 1, 'drain ran once');

  process.exitCode = 0; // don't leak a failing exit code to the runner
});

test('fatal forced-exit timer fires once when a slow drain outlives it — without killing Node', async () => {
  let finishDbClose;
  const slowClose = new Promise((resolve) => { finishDbClose = resolve; });
  const { composition } = fatalComposition({ dbClose: () => slowClose });
  const exits = [];
  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
    fatalExitTimeoutMs: 40,
    exit: (code) => exits.push(code),
  });

  const fatal = runtime.handleFatal('uncaughtException', new Error('stuck'));
  // Wait past the bounded forced-exit timer; the process is still alive (exit is injected).
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.deepEqual(exits, [1], 'bounded timer forced exit(1) despite the hung drain');
  assert.equal(process.exitCode, 1);

  // If the slow drain eventually completes after the forced-exit callback, the finally path must not
  // call exit a second time (the injected exit returns, unlike the real process.exit).
  finishDbClose();
  await fatal;
  assert.deepEqual(exits, [1], 'forced exit and late drain completion share one exit(1)');

  process.exitCode = 0;
});
