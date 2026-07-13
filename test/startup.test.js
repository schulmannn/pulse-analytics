// Startup integration — доказывает, что server/index.js собирает app через createApp
// (server/app.js), слушает порт и что boot-цепочка db.init → migrate → bootstrapAdmin →
// claimOwnerChannel доводит dbReady=true против РЕАЛЬНОГО Postgres. DB-less smoke/
// characterization этого не покрывают (там БД выключена). SKIP без TEST_DATABASE_URL,
// поэтому `npm run check` остаётся DB-less; локальный стенд и CI-with-PG прогоняют:
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable node --test test/startup.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (startup suite runs on the local stand / CI-with-PG)';

let app = null;
let db = null;
let server = null;

test.before(async () => {
  if (!TEST_DB) return;
  // db/pool.js читает DATABASE_URL при require → ставим env ДО require(index).
  process.env.DATABASE_URL = TEST_DB;
  process.env.PGSSL = process.env.PGSSL || 'disable';
  // require(index) на module-load: config=loadConfig(env) → const app=createApp(deps) →
  // db.init().then(bootstrapAdmin).then(claimOwnerChannel) (fire-and-forget). require.main !==
  // module ⇒ app.listen НЕ вызывается — порт открываем сами. ADMIN_* не заданы ⇒ bootstrap/claim
  // безвредные no-op (в БД ничего не пишем, чистить нечего).
  ({ app } = require('../server/index.js'));
  db = require('../server/db.js');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (db && db.close) await db.close();
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

test('boot: index строит app через createApp и слушает; /api/health отвечает 200', { skip }, async () => {
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  const j = JSON.parse(health.body);
  assert.equal(j.service, 'pulse-analytics-web');
  assert.equal(j.status, 'ok');
});

test('boot: db.init→migrate→bootstrap→claim доводит dbReady=true; /api/ready → 200 ready', { skip }, async () => {
  // db.init запущен на require(index) fire-and-forget; ждём готовности через /api/ready
  // (до ~10с: миграции стенда идемпотентны, но первый прогон может что-то мигрировать).
  let ready = null;
  for (let i = 0; i < 100; i++) {
    ready = await get('/api/ready');
    if (ready.status === 200) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(ready.status, 200, `/api/ready не стал 200 (last: ${ready && ready.body})`);
  const jr = JSON.parse(ready.body);
  assert.equal(jr.status, 'ready');
  assert.equal(jr.database.ok, true);
  // /api/health теперь database_ready:true — тот же живой флаг через getDbReady() (доказывает,
  // что инъектированный accessor читает мутирующийся index-scope dbReady, а не снимок на старте).
  const health = JSON.parse((await get('/api/health')).body);
  assert.equal(health.database_ready, true);
});
