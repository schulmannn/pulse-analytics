'use strict';

// Route-тесты /api/ai/* (fake-app паттерн campaigns_route): auth/super пропускаются
// pass-middleware (401-контракт держит http_characterization), сервис и db — стабы.
// Проверяем маппинг кодов preflight в статусы, 503-гейты и механику SSE-ответа.

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAiRoutes } = require('../server/routes/ai');

function buildRoutes({ service = {}, db = {}, dbReady = true } = {}) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    post(path, ...h) { routes.set(`POST ${path}`, h); },
    delete(path, ...h) { routes.set(`DELETE ${path}`, h); },
  };
  const pass = (_req, _res, next) => next();
  registerAiRoutes({
    app,
    db: { enabled: true, getAiUsageToday: async () => ({ messages: 3 }), ...db },
    requireAuth: pass,
    requireSuper: pass,
    aiChatService: baseService(service),
    audit: async () => {},
    log: () => {},
    getDbReady: () => dbReady,
  });
  return routes;
}

function baseService(over = {}) {
  return {
    available: () => true,
    dailyMessageLimit: 200,
    listChats: async () => [{ id: 1, title: 'Динамика недели' }],
    createChat: async () => ({ id: 2, title: '' }),
    getChatWithMessages: async () => ({ chat: { id: 1, title: 'x' }, messages: [] }),
    deleteChat: async () => true,
    preflight: async () => ({ chat: { id: 1, title: '' } }),
    answer: async ({ emit }) => {
      emit({ type: 'meta', chat_id: 1, title: 'Вопрос' });
      emit({ type: 'text', delta: 'Привет' });
      emit({ type: 'done', message_id: 7 });
      return { ok: true };
    },
    ...over,
  };
}

function jsonRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function sseRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writableEnded: false,
    flushed: false,
    status(code) { this.statusCode = code; return this; },
    set(h) { Object.assign(this.headers, h); return this; },
    flushHeaders() { this.flushed = true; },
    write(s) { this.chunks.push(s); return true; },
    json(payload) { this.body = payload; return this; },
    end() { this.writableEnded = true; },
  };
}

async function invoke(routes, key, { params = {}, body = {}, res = jsonRes() } = {}) {
  const handler = routes.get(key).at(-1);
  let nextError = null;
  await handler(
    { params, body, user: { uid: 11, role: 'superuser' }, on() {}, requestId: 't' },
    res,
    (e) => { nextError = e; },
  );
  if (nextError) throw nextError;
  return res;
}

test('503, когда провайдер не настроен (available=false) — на всех роутах', async () => {
  const routes = buildRoutes({ service: { available: () => false } });
  for (const key of routes.keys()) {
    const res = await invoke(routes, key, { params: { id: '1' } });
    assert.equal(res.statusCode, 503, key);
    assert.match(res.body.error, /не настроен/);
  }
});

test('503, когда БД ещё не готова (getDbReady=false)', async () => {
  const routes = buildRoutes({ dbReady: false });
  const res = await invoke(routes, 'GET /api/ai/chats');
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /БД/);
});

test('GET /api/ai/chats → {chats, usage{used,limit}}', async () => {
  const routes = buildRoutes();
  const res = await invoke(routes, 'GET /api/ai/chats');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.chats.length, 1);
  assert.deepEqual(res.body.usage, { used: 3, limit: 200 });
});

test('GET/DELETE несуществующего чата → 404 без утечки', async () => {
  const routes = buildRoutes({
    service: { getChatWithMessages: async () => null, deleteChat: async () => false },
  });
  for (const key of ['GET /api/ai/chats/:id', 'DELETE /api/ai/chats/:id']) {
    const res = await invoke(routes, key, { params: { id: '99' } });
    assert.equal(res.statusCode, 404, key);
  }
});

test('POST messages: preflight-коды маппятся в статусы (400/404/429/503)', async () => {
  const cases = [
    ['bad_text', 400],
    ['not_found', 404],
    ['quota', 429],
    ['off', 503],
  ];
  for (const [code, status] of cases) {
    const routes = buildRoutes({
      service: {
        preflight: async () => { throw Object.assign(new Error(`err ${code}`), { code }); },
      },
    });
    const res = await invoke(routes, 'POST /api/ai/chats/:id/messages', {
      params: { id: '1' }, body: { text: 'вопрос' },
    });
    assert.equal(res.statusCode, status, code);
    assert.match(res.body.error, new RegExp(code));
  }
});

test('POST messages: happy-path — SSE-заголовки, события meta/text/done, стрим закрыт', async () => {
  const routes = buildRoutes();
  const res = sseRes();
  await invoke(routes, 'POST /api/ai/chats/:id/messages', {
    params: { id: '1' }, body: { text: 'Как растёт канал?' }, res,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.headers['Cache-Control'], /no-transform/);
  assert.ok(res.flushed, 'flushHeaders вызван до стрима');
  const events = res.chunks
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)));
  assert.deepEqual(events.map((e) => e.type), ['meta', 'text', 'done']);
  assert.ok(res.writableEnded, 'ответ завершён');
});

test('POST messages: неожиданный сбой answer → error-событие в стриме, стрим закрыт', async () => {
  const routes = buildRoutes({
    service: { answer: async () => { throw new Error('boom'); } },
  });
  const res = sseRes();
  await invoke(routes, 'POST /api/ai/chats/:id/messages', {
    params: { id: '1' }, body: { text: 'вопрос' }, res,
  });
  const events = res.chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
  assert.equal(events.at(-1).type, 'error');
  assert.ok(res.writableEnded);
});
