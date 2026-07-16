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

// The hot path resolves the channel with ONE repo call — getChannelOrDefault. The old
// getDefaultChannelId + getChannel pair (and the even heavier listChannels) must NOT run here;
// throwing from them guards that resolveChannel never falls back to an extra round-trip.
function hotPathDb(overrides) {
  return {
    enabled: true,
    calls: [],
    listChannels: async () => { throw new Error('listChannels must not run on the auth/tenant hot path'); },
    getDefaultChannelId: async () => { throw new Error('getDefaultChannelId must not run on the auth/tenant hot path'); },
    getChannel: async () => { throw new Error('getChannel must not run on the auth/tenant hot path'); },
    ...overrides,
  };
}

test('tenant middleware rejects an explicit channel owned by another user (403)', async () => {
  const db = hotPathDb({
    getChannelOrDefault: async function (id, user) {
      this.calls.push({ id, uid: user.uid });
      return id === 10 && user.uid === 1 ? { id: 10, owner_uid: 1, source: 'collector' } : null;
    },
  });
  const resolve = makeResolveChannel({ db, isReady: () => true });
  const req = { query: { channel: '20' }, headers: {}, user: { uid: 1, role: 'user' } };
  const res = responseRecorder();
  let nextCalled = false;
  await resolve(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(db.calls, [{ id: 20, uid: 1 }], 'exactly one resolver call, with the explicit id');
});

test('tenant middleware attaches an owned channel and continues (one resolver call)', async () => {
  const owned = { id: 10, owner_uid: 1, source: 'collector', member_role: 'owner' };
  const db = hotPathDb({
    getChannelOrDefault: async function (id, user) {
      this.calls.push({ id, uid: user.uid });
      return id === 0 && user.uid === 1 ? owned : null;
    },
  });
  const resolve = makeResolveChannel({ db, isReady: () => true });
  const req = { query: {}, headers: {}, user: { uid: 1, role: 'user' } };
  const res = responseRecorder();
  let nextCalled = false;
  await resolve(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(req.channel, owned);
  assert.deepStrictEqual(db.calls, [{ id: 0, uid: 1 }], 'default path makes one resolver call with id 0');
});

test('tenant middleware returns the empty payload when the user has no default channel (200)', async () => {
  const db = hotPathDb({ getChannelOrDefault: async () => null });
  const resolve = makeResolveChannel({ db, isReady: () => true });
  const req = { query: {}, headers: {}, user: { uid: 1, role: 'user' } };
  const res = responseRecorder();
  let nextCalled = false;
  await resolve(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { enabled: true, empty: true, channels: [] });
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
