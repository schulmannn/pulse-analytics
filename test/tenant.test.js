const test = require('node:test');
const assert = require('node:assert/strict');
const { makeResolveChannel } = require('../server/middleware/tenant');

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
