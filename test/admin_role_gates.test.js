'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAccountRoutes } = require('../server/routes/account');
const { registerChannelsRoutes } = require('../server/routes/channels');
const { registerBugsRoutes } = require('../server/routes/bugs');

// Route-level pins for the admin/workspace role gates. The middleware wiring (requireSuper in the
// chain), the self-lockout guard and the validation-vs-DB-failure split previously had no tests:
// a refactor dropping any of them would ship silently. Fakes follow test/history_route.test.js.

const SECRET_DB_ERROR = 'password=hunter2 host=db.internal SELECT * FROM secrets';

function fakeApp(routes) {
  const capture = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers);
  return { get: capture('GET'), post: capture('POST'), put: capture('PUT'), patch: capture('PATCH'), delete: capture('DELETE') };
}

async function invoke(routes, key, { user, params = {}, body, query = {} } = {}) {
  const handlers = routes.get(key);
  assert.ok(handlers, `route ${key} is registered`);
  const req = { user, params, body, query, headers: {} };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let forwarded = null;
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, (err) => { if (err) { forwarded = err; return; } advanced = true; });
    if (!advanced) break;
  }
  return { res, forwarded, req };
}

// ── account.js: /api/admin/users ────────────────────────────────────────────────────────────────

function createAccountRoutes(over = {}) {
  const routes = new Map();
  const requireSuper = over.requireSuper || ((_req, _res, next) => next());
  const db = {
    enabled: true,
    getUserById: async (id) => ({ id, role: 'user', status: 'active' }),
    updateUser: async (id) => ({ id, role: 'user', status: 'active' }),
    deleteUserAccount: async () => true,
    getPrefs: async () => null,
    setPrefs: async () => true,
    listUsers: async () => [],
    USER_ROLES: ['user', 'superuser'],
    USER_STATUSES: ['active', 'disabled'],
    ...over.db,
  };
  registerAccountRoutes({
    app: fakeApp(routes),
    requireAuth: (_req, _res, next) => next(),
    requireSuper,
    db,
    audit: async () => {},
    sendEmail: async () => {},
    emailShell: (x) => x,
    GOOGLE_CLIENT_ID: null,
  });
  return { routes, requireSuper };
}

test('every /api/admin/users route keeps the injected requireSuper in its chain', () => {
  const marker = (_req, _res, next) => next();
  const { routes } = createAccountRoutes({ requireSuper: marker });
  for (const key of ['GET /api/admin/users', 'PATCH /api/admin/users/:id', 'DELETE /api/admin/users/:id']) {
    assert.ok(routes.get(key), `route ${key} is registered`);
    assert.ok(routes.get(key).includes(marker), `${key} must be gated by requireSuper`);
  }
});

test('admin cannot demote or disable their own account (self-lockout guard)', async () => {
  const updated = [];
  const { routes } = createAccountRoutes({
    db: { updateUser: async (id, patch) => { updated.push({ id, patch }); return { id }; } },
  });
  for (const body of [{ role: 'user' }, { status: 'disabled' }]) {
    const { res } = await invoke(routes, 'PATCH /api/admin/users/:id', {
      user: { uid: 7, role: 'superuser' },
      params: { id: '7' },
      body,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(res.body.error, /собственный аккаунт/);
  }
  assert.equal(updated.length, 0, 'the guard must fire before any write');
});

test('admin PATCH without a JSON body does not crash on req.body access', async () => {
  const { routes } = createAccountRoutes();
  const { res, forwarded } = await invoke(routes, 'PATCH /api/admin/users/:id', {
    user: { uid: 1, role: 'superuser' },
    params: { id: '7' },
    body: undefined,
  });
  assert.equal(forwarded, null);
  assert.equal(res.statusCode, 200);
});

test('admin PATCH keeps 400 for repo validation but forwards DB failures to the central handler', async () => {
  const bad = createAccountRoutes({
    db: { updateUser: async () => { throw new Error('bad role'); } },
  });
  const badRes = await invoke(bad.routes, 'PATCH /api/admin/users/:id', {
    user: { uid: 1, role: 'superuser' },
    params: { id: '7' },
    body: { role: 'nonsense' },
  });
  assert.equal(badRes.res.statusCode, 400);
  assert.equal(badRes.res.body.error, 'bad role');

  const down = createAccountRoutes({
    db: { updateUser: async () => { throw new Error(SECRET_DB_ERROR); } },
  });
  const downRes = await invoke(down.routes, 'PATCH /api/admin/users/:id', {
    user: { uid: 1, role: 'superuser' },
    params: { id: '7' },
    body: { role: 'user' },
  });
  assert.ok(downRes.forwarded, 'DB failure must go to next(e), not a 400 with the driver message');
  assert.equal(downRes.res.body, undefined, 'no response body was written by the route');
});

test('admin DELETE refuses superuser targets and deletes ordinary users', async () => {
  const { routes } = createAccountRoutes({
    db: {
      getUserById: async (id) => ({ id, role: id === 1 ? 'superuser' : 'user' }),
    },
  });
  const refused = await invoke(routes, 'DELETE /api/admin/users/:id', {
    user: { uid: 5, role: 'superuser' },
    params: { id: '1' },
  });
  assert.equal(refused.res.statusCode, 400);
  assert.match(refused.res.body.error, /Суперюзера/);

  const ok = await invoke(routes, 'DELETE /api/admin/users/:id', {
    user: { uid: 5, role: 'superuser' },
    params: { id: '9' },
  });
  assert.equal(ok.res.statusCode, 200);
  assert.deepEqual(ok.res.body, { ok: true });
});

// ── channels.js: collector keys + annotations (workspace role gates) ────────────────────────────

function createChannelRoutes(over = {}) {
  const routes = new Map();
  const calls = { createApiKey: [], createAnnotation: [] };
  const db = {
    enabled: true,
    getChannel: async () => null,
    createApiKey: async (...args) => { calls.createApiKey.push(args); return { id: 1, key_prefix: 'pa_test' }; },
    listApiKeys: async () => [],
    revokeApiKey: async () => true,
    listAnnotations: async () => [],
    createAnnotation: async (...args) => { calls.createAnnotation.push(args); return { id: 11 }; },
    deleteAnnotation: async () => true,
    ...over.db,
  };
  registerChannelsRoutes({
    app: fakeApp(routes),
    db,
    requireAuth: (_req, _res, next) => next(),
    audit: async () => {},
    getDbReady: () => true,
  });
  return { routes, calls };
}

const USER = { uid: 7, role: 'user' };
// member_role drives hasWorkspaceRole; owner_uid === uid resolves to 'owner'.
const asViewer = { id: 42, source: 'qr', member_role: 'viewer' };
const asMember = { id: 42, source: 'qr', member_role: 'member' };
const asOwner = { id: 42, source: 'qr', owner_uid: 7 };

test('collector API keys are admin-only: viewer and member get 403, owner succeeds', async () => {
  for (const channel of [asViewer, asMember]) {
    const { routes, calls } = createChannelRoutes({ db: { getChannel: async () => channel } });
    const { res } = await invoke(routes, 'POST /api/channels/:id/key', {
      user: USER, params: { id: '42' }, body: {},
    });
    assert.equal(res.statusCode, 403, `member_role=${channel.member_role}`);
    assert.match(res.body.error, /Недостаточно прав/);
    assert.equal(calls.createApiKey.length, 0);
  }

  const owner = createChannelRoutes({ db: { getChannel: async () => asOwner } });
  const { res } = await invoke(owner.routes, 'POST /api/channels/:id/key', {
    user: USER, params: { id: '42' }, body: {},
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.key, /^pa_/, 'raw key is returned once');
  assert.equal(owner.calls.createApiKey.length, 1);
});

test('a channel outside the actor scope yields 403 before any key operation', async () => {
  const { routes, calls } = createChannelRoutes(); // getChannel → null = no access
  const { res } = await invoke(routes, 'POST /api/channels/:id/key', {
    user: USER, params: { id: '42' }, body: {},
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Нет доступа/);
  assert.equal(calls.createApiKey.length, 0);
});

test('central channels never mint collector keys', async () => {
  const { routes } = createChannelRoutes({
    db: { getChannel: async () => ({ id: 42, source: 'central', owner_uid: 7 }) },
  });
  const { res } = await invoke(routes, 'POST /api/channels/:id/key', {
    user: USER, params: { id: '42' }, body: {},
  });
  assert.equal(res.statusCode, 400);
});

test('annotations need member: viewer gets 403, member creates', async () => {
  const viewer = createChannelRoutes({ db: { getChannel: async () => asViewer } });
  const denied = await invoke(viewer.routes, 'POST /api/channels/:id/annotations', {
    user: USER, params: { id: '42' }, body: { day: '2026-07-01', label: 'релиз' },
  });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(viewer.calls.createAnnotation.length, 0);

  const member = createChannelRoutes({ db: { getChannel: async () => asMember } });
  const ok = await invoke(member.routes, 'POST /api/channels/:id/annotations', {
    user: USER, params: { id: '42' }, body: { day: '2026-07-01', label: 'релиз' },
  });
  assert.equal(ok.res.statusCode, 200);
  assert.equal(member.calls.createAnnotation.length, 1);
});

// ── bugs.js: validation-vs-failure split + degradation hygiene ──────────────────────────────────

function createBugsRoutes(over = {}) {
  const routes = new Map();
  const logs = [];
  const db = {
    enabled: true,
    listBugs: async () => [],
    updateBug: async (id) => ({ id, status: 'done' }),
    deleteBug: async () => {},
    createBug: async () => ({ id: 1 }),
    BUG_STATUSES: ['open', 'in_progress', 'done'],
    BUG_KINDS: ['bug'],
    ...over.db,
  };
  registerBugsRoutes({
    app: fakeApp(routes),
    express: { json: () => (_req, _res, next) => next(), raw: () => (_req, _res, next) => next() },
    db,
    rateLimit: () => (_req, _res, next) => next(),
    requireAuth: (_req, _res, next) => next(),
    requireSuper: (_req, _res, next) => next(),
    fetchWithTimeout: async () => { throw new Error('no network in tests'); },
    AUTH_SECRET: 'test-secret',
    commitSha: null,
    githubRepo: null,
    githubDispatchToken: null,
    notionCrash: null,
    log: (level, event, meta) => logs.push({ level, event, meta }),
  });
  return { routes, logs };
}

test('bug status PATCH keeps 400 for validation but forwards DB failures', async () => {
  const bad = createBugsRoutes({ db: { updateBug: async () => { throw new Error('bad status'); } } });
  const badRes = await invoke(bad.routes, 'PATCH /api/bugs/:id', {
    user: { uid: 1, role: 'superuser' }, params: { id: '3' }, body: { status: 'nonsense' },
  });
  assert.equal(badRes.res.statusCode, 400);
  assert.equal(badRes.res.body.error, 'bad status');

  const down = createBugsRoutes({ db: { updateBug: async () => { throw new Error(SECRET_DB_ERROR); } } });
  const downRes = await invoke(down.routes, 'PATCH /api/bugs/:id', {
    user: { uid: 1, role: 'superuser' }, params: { id: '3' }, body: { status: 'done' },
  });
  assert.ok(downRes.forwarded, 'DB failure must reach the central handler');
});

test('bug list degrades to a shaped 200 without leaking the raw DB error', async () => {
  const { routes, logs } = createBugsRoutes({
    db: { listBugs: async () => { throw new Error(SECRET_DB_ERROR); } },
  });
  const { res } = await invoke(routes, 'GET /api/bugs', {
    user: { uid: 1, role: 'superuser' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.bugs, []);
  assert.ok(!res.body.error.includes('hunter2'), 'raw DB error must not leak to the client');
  assert.ok(logs.some((entry) => entry.event === 'bugs_list_read_failed'));
});
