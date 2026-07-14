'use strict';

// Route-тесты /api/campaigns (fake-app паттерн tg_posts_route): auth пропускается pass-middleware
// (401-контракт держит http_characterization), db — стаб. Проверяем маппинг статусов:
// 400 валидация, 403 роль/источник, 404 без утечки, 409 конфликты, санитизацию ответа
// и «404 раньше 403» для чужой кампании.

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerCampaignsRoutes } = require('../server/routes/campaigns');

function buildRoutes(db) {
  const routes = new Map();
  const app = {
    get(path, ...h) { routes.set(`GET ${path}`, h); },
    post(path, ...h) { routes.set(`POST ${path}`, h); },
    patch(path, ...h) { routes.set(`PATCH ${path}`, h); },
    delete(path, ...h) { routes.set(`DELETE ${path}`, h); },
  };
  const pass = (_req, _res, next) => next();
  registerCampaignsRoutes({ app, db, requireAuth: pass, audit: async () => {} });
  return routes;
}

async function invoke(routes, key, { params = {}, query = {}, body = {}, uid = 11 } = {}) {
  const handler = routes.get(key).at(-1);
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(payload) { this.body = payload; return this; },
  };
  let nextError = null;
  await handler({ params, query, body, user: { uid } }, res, (e) => { nextError = e; });
  if (nextError) throw nextError;
  return res;
}

const CAMPAIGN = {
  id: 5, workspace_id: 2, name: 'Запуск', description: '', color: null, status: 'active',
  start_date: null, end_date: null, created_by: 11, my_role: 'owner', post_count: 0,
};

const baseDb = (over = {}) => ({
  enabled: true,
  CAMPAIGN_STATUSES: ['active', 'completed', 'archived'],
  CAMPAIGN_BATCH_LIMIT: 100,
  listCampaigns: async () => [CAMPAIGN],
  getCampaign: async () => CAMPAIGN,
  createCampaign: async () => CAMPAIGN,
  updateCampaign: async () => CAMPAIGN,
  deleteCampaign: async () => true,
  addCampaignPosts: async () => ({ added: 1, skipped: 0, invalid: [] }),
  removeCampaignPosts: async () => ({ removed: 1 }),
  listCampaignPosts: async () => [],
  getCampaignSummary: async () => ({ posts_total: 0 }),
  ...over,
});

test('без БД все эндпоинты → 503 {error}', async () => {
  const routes = buildRoutes({ enabled: false });
  for (const key of routes.keys()) {
    const res = await invoke(routes, key, { params: { id: '5' } });
    assert.equal(res.statusCode, 503, key);
    assert.match(res.body.error, /БД не подключена/);
  }
});

test('POST /api/campaigns: валидация name/color/status/дат', async () => {
  const routes = buildRoutes(baseDb());
  const cases = [
    [{}, /name/],
    [{ name: 'ok' }, /channel_id/],
    [{ channel_id: 1, name: {} }, /name/],
    [{ channel_id: 0, name: 'ok' }, /channel_id/],
    [{ name: 'x'.repeat(121) }, /name/],
    [{ name: 'ok', color: 'red' }, /color/],
    [{ name: 'ok', status: 'paused' }, /status/],
    [{ name: 'ok', start_date: '10.06.2026' }, /start_date/],
    [{ name: 'ok', start_date: '2026-02-31' }, /start_date/],
    [{ name: 'ok', start_date: '2026-06-12', end_date: '2026-06-10' }, /end_date раньше/],
  ];
  for (const [body, re] of cases) {
    const res = await invoke(routes, 'POST /api/campaigns', { body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(res.body.error, re);
  }
  const ok = await invoke(routes, 'POST /api/campaigns', {
    body: { channel_id: 1, name: 'Запуск', color: '#2D6BE0', start_date: '2026-06-10', end_date: '2026-06-12' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.campaign.id, 5);
});

test('409: дубль имени (create и patch) и лимит membership', async () => {
  const conflict = Object.assign(new Error('Кампания с таким названием уже есть'), { code: 'campaign_name_conflict' });
  const routes = buildRoutes(baseDb({
    createCampaign: async () => { throw conflict; },
    updateCampaign: async () => { throw conflict; },
    addCampaignPosts: async () => {
      throw Object.assign(new Error('Лимит публикаций в кампании — 500'), { code: 'campaign_limit' });
    },
  }));
  const create = await invoke(routes, 'POST /api/campaigns', { body: { channel_id: 1, name: 'Запуск' } });
  assert.equal(create.statusCode, 409);
  const patch = await invoke(routes, 'PATCH /api/campaigns/:id', { params: { id: '5' }, body: { name: 'Запуск' } });
  assert.equal(patch.statusCode, 409);
  const add = await invoke(routes, 'POST /api/campaigns/:id/posts', {
    params: { id: '5' }, body: { items: [{ network: 'tg', channel_id: 1, post_ref: '10' }] },
  });
  assert.equal(add.statusCode, 409);
  assert.match(add.body.error, /Лимит/);
});

test('404 без утечки: чужая/несуществующая кампания на READ и WRITE', async () => {
  const routes = buildRoutes(baseDb({
    getCampaign: async () => null,
    listCampaignPosts: async () => null,
    getCampaignSummary: async () => null,
  }));
  for (const [key, opts] of [
    ['GET /api/campaigns/:id', {}],
    ['PATCH /api/campaigns/:id', { body: { name: 'x' } }],
    ['DELETE /api/campaigns/:id', {}],
    ['POST /api/campaigns/:id/posts', { body: { items: [{ network: 'tg', channel_id: 1, post_ref: '1' }] } }],
    ['DELETE /api/campaigns/:id/posts', { body: { items: [{ network: 'tg', channel_id: 1, post_ref: '1' }] } }],
    ['GET /api/campaigns/:id/posts', {}],
    ['GET /api/campaigns/:id/summary', {}],
  ]) {
    const res = await invoke(routes, key, { params: { id: '5' }, ...opts });
    assert.equal(res.statusCode, 404, key);
  }
});

test('403: viewer не пишет (404 идёт РАНЬШЕ 403 — только для видимой кампании)', async () => {
  const routes = buildRoutes(baseDb({
    getCampaign: async () => ({ ...CAMPAIGN, my_role: 'viewer' }),
  }));
  for (const [key, opts] of [
    ['PATCH /api/campaigns/:id', { body: { name: 'x' } }],
    ['DELETE /api/campaigns/:id', {}],
    ['POST /api/campaigns/:id/posts', { body: { items: [{ network: 'tg', channel_id: 1, post_ref: '1' }] } }],
    ['DELETE /api/campaigns/:id/posts', { body: { items: [{ network: 'tg', channel_id: 1, post_ref: '1' }] } }],
  ]) {
    const res = await invoke(routes, key, { params: { id: '5' }, ...opts });
    assert.equal(res.statusCode, 403, key);
    assert.match(res.body.error, /Недостаточно прав/);
  }
});

test('403: недоступный источник при добавлении постов', async () => {
  const routes = buildRoutes(baseDb({
    addCampaignPosts: async () => {
      throw Object.assign(new Error('Нет доступа к источнику'), { code: 'campaign_channel_forbidden', channels: [9] });
    },
  }));
  const res = await invoke(routes, 'POST /api/campaigns/:id/posts', {
    params: { id: '5' }, body: { items: [{ network: 'tg', channel_id: 9, post_ref: '1' }] },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Нет доступа к источнику/);
});

test('create/add: доменные ошибки workspace, роли и платформы получают стабильные статусы', async () => {
  for (const [code, route, expected] of [
    ['campaign_role_forbidden', 'POST /api/campaigns', 403],
    ['campaign_channel_forbidden', 'POST /api/campaigns', 403],
    ['campaign_workspace_mismatch', 'POST /api/campaigns/:id/posts', 409],
    ['campaign_network_mismatch', 'POST /api/campaigns/:id/posts', 400],
  ]) {
    const failure = Object.assign(new Error(code), { code });
    const db = route === 'POST /api/campaigns'
      ? baseDb({ createCampaign: async () => { throw failure; } })
      : baseDb({ addCampaignPosts: async () => { throw failure; } });
    const routes = buildRoutes(db);
    const opts = route === 'POST /api/campaigns'
      ? { body: { channel_id: 1, name: 'Запуск' } }
      : { params: { id: '5' }, body: { items: [{ network: 'tg', channel_id: 1, post_ref: '1' }] } };
    const res = await invoke(routes, route, opts);
    assert.equal(res.statusCode, expected, code);
  }
});

test('items-валидация: форма, network, post_ref по платформе, размер батча, дедуп', async () => {
  let received = null;
  const routes = buildRoutes(baseDb({
    addCampaignPosts: async (_uid, _id, items) => { received = items; return { added: items.length, skipped: 0, invalid: [] }; },
  }));
  const key = 'POST /api/campaigns/:id/posts';
  const bad = [
    [{}, /items/],
    [{ items: [] }, /items/],
    [{ items: [{ network: 'vk', channel_id: 1, post_ref: '1' }] }, /network/],
    [{ items: [{ network: 'tg', channel_id: 'x', post_ref: '1' }] }, /channel_id/],
    [{ items: [{ network: 'tg', channel_id: 1, post_ref: 'abc' }] }, /post_ref/],
    [{ items: [{ network: 'tg', channel_id: 1, post_ref: '0' }] }, /post_ref/],
    [{ items: [{ network: 'tg', channel_id: 1, post_ref: '9999999999999999999' }] }, /post_ref/],
    [{ items: [{ network: 'ig', channel_id: 1, post_ref: 'bad ref!' }] }, /post_ref/],
    [{ items: [{ network: 'ig', channel_id: 1, post_ref: 'm1', published_at: 'вчера' }] }, /published_at/],
    [{ items: [{ network: 'ig', channel_id: 1, post_ref: 'm1', media_type: {} }] }, /media_type/],
    [{ items: [{ network: 'ig', channel_id: 1, post_ref: 'm1', caption: {} }] }, /caption/],
    [{ items: Array.from({ length: 101 }, (_, i) => ({ network: 'tg', channel_id: 1, post_ref: String(i + 1) })) }, /не больше 100/],
  ];
  for (const [body, re] of bad) {
    const res = await invoke(routes, key, { params: { id: '5' }, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 60));
    assert.match(res.body.error, re);
  }
  const dup = await invoke(routes, key, {
    params: { id: '5' },
    body: {
      items: [
        { network: 'tg', channel_id: 1, post_ref: '10' },
        { network: 'tg', channel_id: 1, post_ref: '10' },
        { network: 'ig', channel_id: 2, post_ref: 'media_1', media_type: 'REELS', caption: 'x'.repeat(500) },
      ],
    },
  });
  assert.equal(dup.statusCode, 200);
  assert.equal(received.length, 2, 'дубль внутри запроса схлопнут');
  assert.equal(received[1].caption.length, 300, 'ig caption обрезается');
  assert.equal(received[0].published_at, undefined, 'tg-метаданные от клиента не принимаются');
});

test('GET /:id/posts: недоступная membership не раскрывает channel_id/post_ref', async () => {
  const routes = buildRoutes(baseDb({
    listCampaignPosts: async () => [
      { network: 'tg', channel_id: 1, post_ref: '10', accessible: true, caption: 'мой пост', media_type: 'photo', tg_views: 5 },
      { network: 'tg', channel_id: 9, post_ref: '77', accessible: false, caption: 'чужой пост', media_type: 'video', tg_views: null },
    ],
  }));
  const res = await invoke(routes, 'GET /api/campaigns/:id/posts', { params: { id: '5' } });
  assert.equal(res.statusCode, 200);
  const [mine] = res.body.posts;
  assert.equal(mine.caption, 'мой пост');
  assert.equal(res.body.posts.length, 1);
  assert.equal(res.body.inaccessible_count, 1);
});

test('GET /api/campaigns: невалидный ?status → 400, валидный прокидывается в repo', async () => {
  let got = null;
  const routes = buildRoutes(baseDb({
    listCampaigns: async (_uid, opts) => { got = opts; return []; },
  }));
  const bad = await invoke(routes, 'GET /api/campaigns', { query: { status: 'paused' } });
  assert.equal(bad.statusCode, 400);
  const invalidChannel = await invoke(routes, 'GET /api/campaigns', { query: { channel_id: 'abc' } });
  assert.equal(invalidChannel.statusCode, 400);
  const zeroChannel = await invoke(routes, 'GET /api/campaigns', { query: { channel_id: '0' } });
  assert.equal(zeroChannel.statusCode, 400);
  const ok = await invoke(routes, 'GET /api/campaigns', { query: { status: 'archived', channel_id: '7' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(got.status, 'archived');
  assert.equal(got.channelId, 7);
});

test('bad id: не-числовой :id → 400 на всех /:id-роутах', async () => {
  const routes = buildRoutes(baseDb());
  for (const key of [...routes.keys()].filter((k) => k.includes(':id'))) {
    const res = await invoke(routes, key, { params: { id: 'abc' }, body: { items: [{ network: 'tg', channel_id: 1, post_ref: '1' }], name: 'x' } });
    assert.equal(res.statusCode, 400, key);
    assert.equal(res.body.error, 'bad id');
  }
});
