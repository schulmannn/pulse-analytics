'use strict';

// JOBS_MODE — web-гейт периодических планировщиков (server/main.js), подготовка split-топологии
// «web + отдельный job-worker» (docs/WORKER.md). Покрывается:
//   • дефолт ('inline' / переменная не задана) — прежнее поведение: оба бегунка стартуют;
//   • JOBS_MODE=off — web поднимается БЕЗ планировщиков, HTTP/health живой, shutdown чистый;
//   • нормализация значения (регистр/пробелы);
//   • неизвестное значение — фатально ДО построения composition (молчаливый фолбэк в inline рядом
//     с работающим worker удвоил бы джобы — ADR-002).
// Worker-сторона гейта (worker игнорирует JOBS_MODE) — в test/worker_lifecycle.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { main } = require('../server/main');
const { createJobTracker } = require('../server/infrastructure/jobTracker');

// Фейковая composition в духе main_lifecycle.test.js: реальный express-app с /health, бегунки
// записывают lifecycle-события.
function makeWebComposition() {
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
  return { composition, events };
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
  });
}

test('default (JOBS_MODE unset) keeps prior behavior: both runners start', async () => {
  const { composition, events } = makeWebComposition();
  const runtime = await main({
    env: { NODE_ENV: 'test' },
    port: 0,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
  });
  assert.ok(events.includes('collection.start'), 'collection runner стартует (inline-дефолт)');
  assert.ok(events.includes('operational.start'), 'operational runner стартует (inline-дефолт)');
  await runtime.stop();
});

test('JOBS_MODE=inline (explicit) behaves like the default', async () => {
  const { composition, events } = makeWebComposition();
  const runtime = await main({
    env: { NODE_ENV: 'test', JOBS_MODE: 'inline' },
    port: 0,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
  });
  assert.ok(events.includes('collection.start'));
  assert.ok(events.includes('operational.start'));
  await runtime.stop();
});

test('JOBS_MODE=off: web boots without schedulers, health stays alive, shutdown is clean', async () => {
  const { composition, events } = makeWebComposition();
  const runtime = await main({
    env: { NODE_ENV: 'test', JOBS_MODE: 'off' },
    port: 0,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
  });

  assert.equal(events.includes('collection.start'), false, 'collection runner НЕ стартует');
  assert.equal(events.includes('operational.start'), false, 'operational runner НЕ стартует');
  assert.ok(events.includes('cache.start'), 'кэш-свип не относится к джобам и стартует как раньше');

  // Health жив: web в off-режиме остаётся полноценным HTTP-процессом.
  const boundPort = runtime.server.address().port;
  const res = await getHealth(boundPort);
  assert.equal(res.status, 200);
  assert.match(res.body, /"ok":true/);

  await runtime.stop();
  // stop() зовёт runner.stop() безусловно — для не-стартовавшего бегунка это безопасный no-op,
  // а пул закрывается ровно один раз.
  assert.equal(events.filter((e) => e === 'db.close').length, 1, 'пул закрыт ровно один раз');
  assert.deepEqual(events.slice(-2), ['cache.stop', 'db.close']);
});

test('JOBS_MODE value is normalized (case/whitespace)', async () => {
  const { composition, events } = makeWebComposition();
  const runtime = await main({
    env: { NODE_ENV: 'test', JOBS_MODE: ' OFF ' },
    port: 0,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
  });
  assert.equal(events.includes('collection.start'), false);
  assert.equal(events.includes('operational.start'), false);
  await runtime.stop();
});

test('unknown JOBS_MODE is fatal before the composition is built', async () => {
  let compositionBuilt = false;
  await assert.rejects(
    main({
      env: { NODE_ENV: 'test', JOBS_MODE: 'worker' },
      port: 0,
      compositionFactory: () => {
        compositionBuilt = true;
        return {};
      },
      installSignalHandlers: false,
    }),
    /JOBS_MODE/,
  );
  assert.equal(compositionBuilt, false, 'composition-фабрика не вызвана при невалидном JOBS_MODE');
});
