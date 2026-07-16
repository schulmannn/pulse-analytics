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
