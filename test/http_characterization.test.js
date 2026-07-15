'use strict';

// Characterization-тесты HTTP-поведения server/index.js (PR A декомпозиции index.js). Фиксируют
// ТЕКУЩЕЕ поведение ДО рефакторинга (config/app/main-сплит) — сеть безопасности: любой сдвиг
// middleware-порядка или контрактов роутов в последующих PR (B-F) уронит этот тест. Дополняет
// http_smoke.test.js (health/ready/config/401/404). Гоняется DB-less (DATABASE_URL='').
//
// КЛЮЧЕВОЙ инвариант (спека §4): неизвестный /api/* → JSON 404; неизвестный не-API GET → HTML SPA.
// Если SPA-fallback зарегистрируют ДО /api/*, неизвестный API начнёт отдавать HTML — это ловит тест.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.MTPROTO_URL = '';
process.env.MTPROTO_TOKEN = '';
process.env.RAILWAY_ENVIRONMENT = '';
process.env.RAILWAY_PROJECT_ID = '';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-characterization';

const { loadConfig } = require('../server/config');
const { createComposition } = require('../server/composition');
const composition = createComposition(loadConfig(process.env));
const app = composition.createHttpApp();

let server;
let baseUrl;

test.before(async () => {
  await composition.boot();
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
});

const req = (method, path, opts = {}) => fetch(baseUrl + path, { method, ...opts });

// ── Middleware order (спека §4 — часть поведения, фиксируется тестом) ──────────────────────────
test('middleware order: неизвестный /api/* → JSON 404 (API-обработчик ДО SPA-fallback)', async () => {
  const r = await req('GET', '/api/definitely-not-a-route');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  const body = await r.json();
  assert.equal(body.error, 'not_found');
  assert.equal(typeof body.request_id, 'string');
});

test('middleware order: неизвестный НЕ-API GET обслуживается SPA-fallback, НЕ API-JSON-404', async () => {
  // Инвариант независим от наличия frontend/dist: SPA-fallback (app.get('*')) владеет не-API
  // путями. С собранным dist → 200 text/html; без него (backend-only CI) → 404 БЕЗ JSON-тела.
  // Ключевое: ответ НЕ должен быть API-контрактом {error:'not_found'} (иначе SPA перехватил бы /api).
  const r = await req('GET', '/some/unknown/spa/route');
  const ct = r.headers.get('content-type') || '';
  assert.ok(!ct.includes('application/json'), `не-API GET не должен отдавать JSON (ct=${ct}, status=${r.status})`);
  if (r.status === 200) assert.match(ct, /text\/html/, 'с собранным dist — HTML-shell');
});

test('middleware order: security-заголовки на API-ответах (chain-путь, напр. 404)', async () => {
  // ТЕКУЩЕЕ поведение: security-headers применяются в основной цепочке (404 идёт сквозь неё).
  // /api/health зарегистрирован инлайном и заголовки на нём НЕ ставятся — фиксируем как есть,
  // рефактор не должен это МЕНЯТЬ (спека «сохранение поведения»).
  const r = await req('GET', '/api/no-such-route');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const health = await req('GET', '/api/health');
  assert.equal(health.headers.get('x-content-type-options'), null, '/api/health сейчас БЕЗ security-headers (инлайн-роут) — не менять');
});

// ── Route contract snapshot: текущие status/shape ключевых эндпоинтов (DB-less) ─────────────────
// Auth-гейт: защищённые роуты без сессии → 401 (единый external-shape).
test('route contract: auth-gated роуты без сессии → 401 {error}', async () => {
  for (const path of [
    '/api/auth/me',
    '/api/channels',
    '/api/reports',
    '/api/campaigns',
    '/api/history/channel',
    '/api/tg/mention-settings',
    '/api/tg/mtproto/mentions',
  ]) {
    const r = await req('GET', path);
    assert.equal(r.status, 401, `${path} → 401`);
    const body = await r.json();
    assert.equal(typeof body.error, 'string', `${path} отдаёт {error}`);
  }
});

test('route contract: super-only DELETE /api/cache без сессии → 401', async () => {
  const r = await req('DELETE', '/api/cache');
  assert.equal(r.status, 401);
});

test('route contract: POST /api/ingest/daily без ingest-токена → 401/403', async () => {
  const r = await req('POST', '/api/ingest/daily', { headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok([401, 403].includes(r.status), `ingest без токена → ${r.status} (ожидали 401/403)`);
});

test('route contract: /api/health форма стабильна (uptime/cache/sessions/env)', async () => {
  const r = await req('GET', '/api/health');
  const body = await r.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'pulse-analytics-web');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(body.sessions, 'signed+versioned');
  assert.deepEqual(Object.keys(body.env).sort(), ['auth', 'ig', 'tg']);
});

test('route contract: /api/ready DB-less → 200 {status:ready, database:{enabled:false,ok:true}}', async () => {
  const r = await req('GET', '/api/ready');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ready');
  assert.deepEqual(body.database, { enabled: false, ok: true });
});
