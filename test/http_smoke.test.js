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

const { app } = require('../server/index.js');

let server;
let baseUrl;

test.before(async () => {
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
  assert.equal(typeof body.cache, 'number');
  assert.equal(body.sessions, 'signed+versioned');
  assert.equal(typeof body.database_ready, 'boolean');
  assert.equal(typeof body.request_id, 'string');
  assert.deepEqual(Object.keys(body.env).sort(), ['auth', 'ig', 'tg']);
  assert.equal(body.env.auth, true);
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
