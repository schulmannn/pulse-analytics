const test = require('node:test');
const assert = require('node:assert/strict');
const { makeResolveChannel, makeServeSnapshot } = require('../server/middleware/tenant');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('tenant middleware rejects a channel owned by another user', async () => {
  const db = {
    enabled: true,
    listChannels: async () => [],
    getChannel: async (id, user) => id === 10 && user.uid === 1
      ? { id: 10, owner_uid: 1, source: 'collector' }
      : null,
  };
  const resolve = makeResolveChannel({ db, isReady: () => true });
  const req = {
    query: { channel: '20' },
    headers: {},
    user: { uid: 1, role: 'user' },
  };
  const res = responseRecorder();
  let nextCalled = false;
  await resolve(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('tenant middleware attaches an owned channel and continues', async () => {
  const owned = { id: 10, owner_uid: 1, source: 'collector' };
  const db = {
    enabled: true,
    listChannels: async () => [owned],
    getChannel: async (id, user) => id === 10 && user.uid === 1 ? owned : null,
  };
  const resolve = makeResolveChannel({ db, isReady: () => true });
  const req = { query: {}, headers: {}, user: { uid: 1, role: 'user' } };
  const res = responseRecorder();
  let nextCalled = false;
  await resolve(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(req.channel, owned);
});

test('central snapshot is served only when the requested payload exists', async () => {
  let snapshot = { data: { graphs: { available: true, growth: { x: [1], series: [] } } } };
  const db = { getSnapshotInternal: async (channelId) => channelId === 10 ? snapshot : null };
  const serveSnapshot = makeServeSnapshot({ db });
  const req = { channel: { id: 10, source: 'central' } };

  const hit = responseRecorder();
  assert.equal(await serveSnapshot(req, hit, (data) => data.graphs), true);
  assert.deepEqual(hit.body, snapshot.data.graphs);

  snapshot = { data: { channel: { title: 'Central' } } };
  const miss = responseRecorder();
  assert.equal(await serveSnapshot(req, miss, (data) => data.graphs), false);
  assert.equal(miss.body, null, 'the route keeps control and may use the legacy live fallback');
});

// ── hasWorkspaceRole (pure, ADR-001 write-gates) ──
const { hasWorkspaceRole } = require('../server/middleware/tenant');
const t = require('node:test');
const a = require('node:assert');

t.test('hasWorkspaceRole ranks roles and falls back to creator', () => {
  const user = { uid: 7 };
  a.ok(hasWorkspaceRole({ id: 1, member_role: 'owner' }, user, 'admin'), 'owner ≥ admin');
  a.ok(hasWorkspaceRole({ id: 1, member_role: 'admin' }, user, 'member'), 'admin ≥ member');
  a.ok(!hasWorkspaceRole({ id: 1, member_role: 'viewer' }, user, 'member'), 'viewer < member');
  a.ok(!hasWorkspaceRole({ id: 1, member_role: 'viewer' }, user, 'admin'), 'viewer < admin');
  a.ok(!hasWorkspaceRole({ id: 1, member_role: null, owner_uid: 8 }, user, 'member'), 'no role, foreign creator → deny');
  a.ok(hasWorkspaceRole({ id: 1, member_role: null, owner_uid: 7 }, user, 'owner'), 'legacy row: creator fallback');
  a.ok(hasWorkspaceRole({ id: null }, user, 'owner'), 'DB-off dev mode allows');
  a.throws(() => hasWorkspaceRole({ id: 1 }, user, 'root'), /unknown workspace role/);
});
