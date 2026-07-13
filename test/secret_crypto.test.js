'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIgCrypto } = require('../server/lib/ig_crypto');
const { createTgCrypto } = require('../server/lib/tg_crypto');

test('secret crypto instances are configured only by their injected keys', () => {
  const disabled = createIgCrypto('');
  const enabled = createIgCrypto('first-key');

  assert.equal(disabled.configured(), false);
  assert.throws(() => disabled.encrypt('secret'), /IG_TOKEN_KEY not set/);
  assert.equal(enabled.configured(), true);
  assert.equal(enabled.decrypt(enabled.encrypt('secret')), 'secret');
});

test('independent crypto instances cannot decrypt each other data', () => {
  const first = createTgCrypto('first-key');
  const second = createTgCrypto('second-key');
  const encrypted = first.encrypt('session');

  assert.equal(first.decrypt(encrypted), 'session');
  assert.throws(() => second.decrypt(encrypted));
});

test('64-character hex keys round-trip without environment access', () => {
  const crypto = createIgCrypto('a'.repeat(64));
  const encrypted = crypto.encrypt('token');

  assert.equal(crypto.decrypt(encrypted), 'token');
});
