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

test('MTProto client applies the local default URL only when config is empty', () => {
  const client = createMtprotoClient(
    {},
    { breaker: alwaysOpenBreaker(), fetchImpl: async () => {} },
  );

  assert.equal(client.MTPROTO_URL, 'http://localhost:8001');
  assert.equal(client.MTPROTO_TOKEN, '');
});
