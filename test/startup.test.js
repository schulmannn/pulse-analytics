// Startup integration — доказывает жизненный цикл main() (server/main.js) против
// РЕАЛЬНОГО Postgres: validateConfig → await boot-цепочки (db.init→migrate→bootstrapAdmin→
// claimOwnerChannel) ДО открытия порта → listen → runtime.stop() чисто и идемпотентно.
// DB-less smoke/characterization этого не покрывают (там БД выключена). SKIP без
// TEST_DATABASE_URL, поэтому `npm run check` остаётся DB-less; стенд и CI-with-PG гоняют:
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable node --test test/startup.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (startup suite runs on the local stand / CI-with-PG)';

let runtime = null;

test.before(async () => {
  if (!TEST_DB) return;
  // db/pool.js и config читают env при require → ставим ДО require(main).
  process.env.DATABASE_URL = TEST_DB;
  process.env.PGSSL = process.env.PGSSL || 'disable';
  const { main } = require('../server/main.js');
  // port:0 — эфемерный порт (тестовый override; прод слушает config.http.port).
  // ADMIN_* не заданы ⇒ bootstrapAdmin/claimOwnerChannel — безвредные no-op.
  runtime = await main({ port: 0, installSignalHandlers: false });
});

test.after(async () => {
  if (runtime) await runtime.stop();   // идемпотентен — безопасно после теста stop()
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: runtime.server.address().port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

test('main(): миграции/бутстрап ДО listen — /api/ready отвечает 200 СРАЗУ, без поллинга', { skip }, async () => {
  // main() await'ит boot-цепочку перед открытием порта, поэтому первый же запрос после
  // резолва main() обязан видеть dbReady=true (иначе бы вернулся 503 starting).
  const ready = await get('/api/ready');
  assert.equal(ready.status, 200, `ready ещё не 200: ${ready.body}`);
  const jr = JSON.parse(ready.body);
  assert.equal(jr.status, 'ready');
  assert.equal(jr.database.ok, true);
});

test('main(): /api/health 200 + database_ready:true (живой флаг через getDbReady)', { skip }, async () => {
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  const j = JSON.parse(health.body);
  assert.equal(j.service, 'pulse-analytics-web');
  assert.equal(j.status, 'ok');
  assert.equal(j.database_ready, true);
});

test('runtime.stop(): чистая остановка, повторный вызов безопасен', { skip }, async () => {
  const port = runtime.server.address().port;   // снять ДО close: после address() → null
  await runtime.stop();
  await runtime.stop();   // идемпотентность: второй вызов — no-op, не бросает
  // Порт закрыт: запрос НЕ получает HTTP-ответа (resolve был бы провалом). Конкретный
  // код ошибки платформозависим (ECONNREFUSED локально; в CI keep-alive-агент Node≥19
  // переиспользует убитый сокет → 'socket hang up'/ECONNRESET) — agent:false берёт
  // свежий сокет, а матч по коду не делаем: важен сам reject.
  await assert.rejects(new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false }, resolve).on('error', reject);
  }));
});
