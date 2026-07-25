'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithRequestId, getRequestId } = require('../server/lib/requestContext');
const { requestContext } = require('../server/lib/observability');
const { createMtprotoClient } = require('../server/lib/mtproto-client');

function alwaysOpenBreaker() {
  return {
    tryAcquire: () => ({ ok: true }),
    onSettled() {},
  };
}

function recordingClient(calls) {
  const fetchImpl = async (url, options, timeoutMs) => {
    calls.push({ url, options, timeoutMs });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return createMtprotoClient(
    { url: 'http://mt:8001', token: 't' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );
}

test('getRequestId exposes the id only inside runWithRequestId, surviving awaits', async () => {
  assert.equal(getRequestId(), undefined, 'no store outside a request');
  const seen = await runWithRequestId('req-12345678', async () => {
    const before = getRequestId();
    await new Promise((r) => setTimeout(r, 1));
    return { before, after: getRequestId() };
  });
  assert.equal(seen.before, 'req-12345678');
  assert.equal(seen.after, 'req-12345678', 'async continuations inherit the store');
  assert.equal(getRequestId(), undefined, 'store does not leak past run()');
});

test('mtprotoFetch and mtprotoPost forward x-request-id from the request store', async () => {
  const calls = [];
  const client = recordingClient(calls);

  await runWithRequestId('trace-abc.1234:5678', async () => {
    await client.mtprotoFetch('/health');
    await client.mtprotoPost('/qr/start', { body: { a: 1 } });
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.headers['x-request-id'], 'trace-abc.1234:5678');
    assert.equal(call.options.headers['x-internal-token'], 't', 'auth header untouched');
  }
  assert.equal(
    calls[1].options.headers['content-type'],
    'application/json',
    'body header shape untouched',
  );
});

test('mtproto calls outside a request store (background jobs) send no x-request-id', async () => {
  const calls = [];
  const client = recordingClient(calls);

  await client.mtprotoFetch('/graphs', {}, 60000, 'background');
  await client.mtprotoPost('/qr/collect', { lane: 'background' });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(!('x-request-id' in call.options.headers), 'no header without a request id');
    assert.equal(call.options.headers['x-internal-token'], 't');
  }
});

test('an invalid or empty request id is never sent upstream', async () => {
  const calls = [];
  const client = recordingClient(calls);

  // Too short, bad characters, empty — all fail the Python-side form and must be dropped here.
  for (const bad of ['short', 'плохой id с пробелами', '']) {
    await runWithRequestId(bad, () => client.mtprotoFetch('/health'));
    await runWithRequestId(bad, () => client.mtprotoPost('/qr/start'));
  }

  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.ok(!('x-request-id' in call.options.headers), `"${call.url}" must carry no invalid id`);
  }
});

test('observability requestContext middleware runs the downstream pipeline inside the store', async () => {
  const req = {
    get: (name) => (name === 'x-request-id' ? 'incoming-id-42' : undefined),
    path: '/api/summary',
    method: 'GET',
  };
  const res = { set() {}, on() {} };

  const inside = await new Promise((resolve, reject) => {
    requestContext(req, res, () => {
      // Simulate a route handler: the id must be visible here and after an await.
      Promise.resolve()
        .then(() => new Promise((r) => setTimeout(r, 1)))
        .then(() => resolve(getRequestId()))
        .catch(reject);
    });
  });

  assert.equal(inside, req.requestId, 'downstream sees exactly the middleware-assigned id');
  assert.equal(inside, 'incoming-id-42', 'a valid incoming x-request-id is reused');
  assert.equal(getRequestId(), undefined, 'nothing leaks outside the request');
});

test('requestContext puts a freshly minted id into the store when the incoming one is invalid', async () => {
  const req = { get: () => 'bad id', path: '/api/summary', method: 'GET' };
  const res = { set() {}, on() {} };

  const inside = await new Promise((resolve) => {
    requestContext(req, res, () => resolve(getRequestId()));
  });

  assert.equal(inside, req.requestId, 'store carries the generated UUID');
  assert.match(inside, /^[A-Za-z0-9._:-]{8,100}$/, 'generated id passes the Python-side form');
  assert.notEqual(inside, 'bad id');
});
