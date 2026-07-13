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

  await runtime.stop();
  assert.equal(events.filter((event) => event === 'db.close').length, 1);
});
