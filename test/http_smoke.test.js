const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.MTPROTO_URL = '';
process.env.MTPROTO_TOKEN = '';
process.env.RAILWAY_ENVIRONMENT = '';
process.env.RAILWAY_PROJECT_ID = '';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-http-smoke';

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
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

async function getJson(path) {
  const response = await fetch(baseUrl + path);
  const body = await response.json();
  return { response, body };
}

test('GET /api/health returns the health shape', async () => {
  const { response, body } = await getJson('/api/health');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'pulse-analytics-web');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(body.sessions, 'signed+versioned');
  assert.equal(typeof body.database_ready, 'boolean');
  assert.equal(typeof body.request_id, 'string');
});

test('GET /api/health не рассказывает анониму, какие интеграции настроены', async () => {
  // Прежний блок `env` (ig/tg/auth) — карта поверхности для того, кто ещё не вошёл: видно,
  // какие вертикали подняты и настроен ли session secret. Его не читал ни фронт, ни
  // healthcheck; `cache` ушёл заодно — размер кэша говорит о нагрузке, а пробе не нужен (I-1).
  const { body } = await getJson('/api/health');

  assert.equal(body.env, undefined);
  assert.equal(body.cache, undefined);
  assert.deepEqual(
    Object.keys(body).sort(),
    ['database_ready', 'request_id', 'service', 'sessions', 'status', 'uptime'],
  );
});

test('security-заголовки стоят на РЕАЛЬНЫХ /api-ответах, а не только на 404', async () => {
  // Раньше nosniff доезжал лишь до тех /api-путей, что проваливались сквозь роуты в статику,
  // то есть ни до одного настоящего ответа API. Проверяем 200, 401 и сам health (I-1).
  for (const path of ['/api/health', '/api/ready', '/api/config', '/api/auth/me']) {
    const response = await fetch(baseUrl + path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${path}: nosniff`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', `${path}: x-frame-options`);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${path}: referrer-policy`);
  }
});

test('GET /api/config returns public runtime config', async () => {
  const { response, body } = await getJson('/api/config');

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body), ['google_client_id']);
  assert.equal(body.google_client_id, null);
});

test('GET /api/ready reports DB-less readiness', async () => {
  const { response, body } = await getJson('/api/ready');

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ready');
  assert.deepEqual(body.database, { enabled: false, ok: true });
  assert.equal(typeof body.request_id, 'string');
});

test('GET /api/auth/me without token returns 401', async () => {
  const { response, body } = await getJson('/api/auth/me');

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: 'Сессия истекла, войди снова' });
});

test('unknown /api path returns JSON 404 with app security headers', async () => {
  const { response, body } = await getJson('/api/no-such-route');

  assert.equal(response.status, 404);
  assert.equal(body.error, 'not_found');
  assert.equal(typeof body.request_id, 'string');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});
