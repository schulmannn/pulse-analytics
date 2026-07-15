'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMtprotoClient } = require('../server/lib/mtproto-client');

function alwaysOpenBreaker() {
  return {
    tryAcquire: () => ({ ok: true }),
    onSettled() {},
  };
}

test('MTProto clients use independent injected URL and token values', async () => {
  const calls = [];
  const fetchImpl = async (url, options, timeoutMs) => {
    calls.push({ url, options, timeoutMs });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const first = createMtprotoClient(
    { url: 'http://first:8001', token: 'first-token' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );
  const second = createMtprotoClient(
    { url: 'http://second:8001', token: 'second-token' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );

  await first.mtprotoFetch('/health');
  await second.mtprotoPost('/qr/start');

  assert.equal(calls[0].url, 'http://first:8001/health');
  assert.equal(calls[0].options.headers['x-internal-token'], 'first-token');
  assert.equal(calls[1].url, 'http://second:8001/qr/start');
  assert.equal(calls[1].options.headers['x-internal-token'], 'second-token');
});

function connErr(code = 'ECONNREFUSED') {
  // Shape of a node-fetch v2 connection-establishment failure.
  const e = new Error('socket hang up');
  e.name = 'FetchError';
  e.type = 'system';
  e.code = code;
  return e;
}

function timeoutErr() {
  const e = new Error('network timeout');
  e.name = 'FetchError';
  e.type = 'request-timeout';
  return e;
}

test('mtprotoPost retries a transient connection failure only when explicitly enabled', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) throw connErr();
    return { ok: true, json: async () => ({ id: 'qr1', url: 'tg://login' }) };
  };
  const client = createMtprotoClient(
    { url: 'http://mt:8001', token: 't' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );

  const data = await client.mtprotoPost('/qr/start', { retryConnectionErrors: true });
  assert.equal(attempts, 3);
  assert.equal(data.id, 'qr1');
});

test('mtprotoPost does not retry connection failures by default', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw connErr();
  };
  const client = createMtprotoClient(
    { url: 'http://mt:8001', token: 't' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );

  await assert.rejects(client.mtprotoPost('/qr/poll'), (err) => {
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(attempts, 1);
});

test('mtprotoPost gives up after 3 explicitly enabled connection retries with a 503', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw connErr();
  };
  const client = createMtprotoClient(
    { url: 'http://mt:8001', token: 't' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );

  await assert.rejects(client.mtprotoPost('/qr/start', { retryConnectionErrors: true }), (err) => {
    assert.equal(err.status, 503);
    assert.match(err.message, /недоступен/);
    return true;
  });
  assert.equal(attempts, 3);
});

test('mtprotoPost does not retry a timeout even when connection retries are enabled', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw timeoutErr();
  };
  const client = createMtprotoClient(
    { url: 'http://mt:8001', token: 't' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );

  await assert.rejects(client.mtprotoPost('/qr/start', { retryConnectionErrors: true }), (err) => {
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(attempts, 1);
});

test('mtprotoPost does not retry an ambiguous connection reset', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw connErr('ECONNRESET');
  };
  const client = createMtprotoClient(
    { url: 'http://mt:8001', token: 't' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );

  await assert.rejects(
    client.mtprotoPost('/qr/start', { retryConnectionErrors: true }),
    { status: 503 },
  );
  assert.equal(attempts, 1);
});

test('mtprotoPost does not retry an HTTP error response', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ detail: 'mtproto_unreachable' }),
    };
  };
  const client = createMtprotoClient(
    { url: 'http://mt:8001', token: 't' },
    { breaker: alwaysOpenBreaker(), fetchImpl },
  );

  await assert.rejects(
    client.mtprotoPost('/qr/start', { retryConnectionErrors: true }),
    { status: 503 },
  );
  assert.equal(attempts, 1);
});

function recordingBreaker() {
  const acquired = [];
  const settled = [];
  return {
    acquired,
    settled,
    tryAcquire: (lane) => { acquired.push(lane); return { ok: true }; },
    onSettled: (ok, lane) => { settled.push({ ok, lane }); },
  };
}

test('mtprotoFetch threads the lane to the breaker (defaulting to live)', async () => {
  const breaker = recordingBreaker();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const client = createMtprotoClient({ url: 'http://mt:8001', token: 't' }, { breaker, fetchImpl });

  await client.mtprotoFetch('/health');
  await client.mtprotoFetch('/graphs', {}, 60000, 'background');

  assert.deepEqual(breaker.acquired, ['live', 'background']);
  assert.deepEqual(breaker.settled, [
    { ok: true, lane: 'live' },
    { ok: true, lane: 'background' },
  ]);
});

test('mtprotoPost threads the lane to the breaker (defaulting to live)', async () => {
  const breaker = recordingBreaker();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const client = createMtprotoClient({ url: 'http://mt:8001', token: 't' }, { breaker, fetchImpl });

  await client.mtprotoPost('/qr/start');
  await client.mtprotoPost('/qr/collect', { lane: 'background' });

  assert.deepEqual(breaker.acquired, ['live', 'background']);
  assert.deepEqual(breaker.settled, [
    { ok: true, lane: 'live' },
    { ok: true, lane: 'background' },
  ]);
});

test('a background FloodWait (429) is NOT counted as a breaker failure and keeps its lane', async () => {
  const breaker = recordingBreaker();
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    json: async () => ({ detail: 'flood_wait', retry_after: 7 }),
  });
  const client = createMtprotoClient({ url: 'http://mt:8001', token: 't' }, { breaker, fetchImpl });

  await assert.rejects(
    client.mtprotoFetch('/graphs', {}, 60000, 'background'),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.floodWait, true);
      assert.equal(err.retryAfter, 7);
      return true;
    },
  );
  // FloodWait settles the breaker as OK (not a failure) on the background lane.
  assert.deepEqual(breaker.acquired, ['background']);
  assert.deepEqual(breaker.settled, [{ ok: true, lane: 'background' }]);
});

test('MTProto client applies the local default URL only when config is empty', () => {
  const client = createMtprotoClient(
    {},
    { breaker: alwaysOpenBreaker(), fetchImpl: async () => {} },
  );

  assert.equal(client.MTPROTO_URL, 'http://localhost:8001');
  assert.equal(client.MTPROTO_TOKEN, '');
});
