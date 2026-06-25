const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, hashPassword, verifyPassword, rateLimitKey } = require('../server/lib/auth');

test('signed session preserves token version and rejects tampering', () => {
  const auth = createAuth({ secret: 'test-secret' });
  const token = auth.signSession({
    uid: 42,
    role: 'user',
    exp: Date.now() + 60_000,
    tokenVersion: 7,
  });
  assert.deepStrictEqual(auth.parseToken(token), {
    uid: 42,
    role: 'user',
    tokenVersion: 7,
  });
  assert.strictEqual(auth.parseToken(token.slice(0, -1) + 'x'), null);
});

test('expired session is rejected', () => {
  const auth = createAuth({ secret: 'test-secret' });
  const token = auth.signSession({ uid: 1, role: 'user', exp: Date.now() - 1, tokenVersion: 0 });
  assert.strictEqual(auth.parseToken(token), null);
});

test('scrypt password hashes verify without exposing the password', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$/);
  assert.strictEqual(stored.includes('correct horse'), false);
  assert.strictEqual(verifyPassword('correct horse battery staple', stored), true);
  assert.strictEqual(verifyPassword('wrong', stored), false);
});

test('rate-limit key is per-user for sessions and per-IP otherwise', () => {
  const auth = createAuth({ secret: 'test-secret' });
  const userTok = auth.signSession({ uid: 42, role: 'user', exp: Date.now() + 60_000, tokenVersion: 0 });
  const opTok = auth.signBreakGlass(Date.now() + 60_000);
  // authenticated → keyed by uid, independent of the (proxy-shared) IP
  assert.strictEqual(rateLimitKey(auth.parseToken(userTok), '203.0.113.9'), 'u:42');
  // break-glass (no uid) → per-IP
  assert.strictEqual(rateLimitKey(auth.parseToken(opTok), '203.0.113.9'), 'op:203.0.113.9');
  // forged/garbage token (parseToken → null) → per-IP, so token rotation can't escape the limit
  assert.strictEqual(rateLimitKey(auth.parseToken('garbage'), '198.51.100.7'), 'ip:198.51.100.7');
  assert.strictEqual(rateLimitKey(null, undefined), 'ip:unknown');
});
