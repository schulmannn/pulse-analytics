const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { createAuth, hashPassword, verifyPassword, rateLimitKey, isSessionStale } = require('../server/lib/auth');

const scryptAsync = promisify(crypto.scrypt);

test('signed session preserves token version + exp and rejects tampering', () => {
  const auth = createAuth({ secret: 'test-secret' });
  const exp = Date.now() + 60_000;
  const token = auth.signSession({
    uid: 42,
    role: 'user',
    exp,
    tokenVersion: 7,
  });
  // parseToken exposes exp so requireAuth can slide the session (re-issue past half-life).
  assert.deepStrictEqual(auth.parseToken(token), {
    uid: 42,
    role: 'user',
    tokenVersion: 7,
    exp,
  });
  assert.strictEqual(auth.parseToken(token.slice(0, -1) + 'x'), null);
});

test('isSessionStale flips at half-life (sliding-session re-issue trigger)', () => {
  const ttl = 7 * 24 * 60 * 60 * 1000; // 7d
  const now = 1_000_000_000_000;
  // Fresh token (full life ahead) → not stale, no re-issue.
  assert.strictEqual(isSessionStale(now + ttl, now, ttl), false);
  // Exactly at half-life → not yet (strict <).
  assert.strictEqual(isSessionStale(now + ttl / 2, now, ttl), false);
  // Past half-life → stale → server hands back a fresh token.
  assert.strictEqual(isSessionStale(now + ttl / 2 - 1, now, ttl), true);
  // An old 8h token migrating onto the new 7d window is immediately refreshed on the next request.
  assert.strictEqual(isSessionStale(now + 8 * 60 * 60 * 1000, now, ttl), true);
  // Missing / non-numeric exp is a no-op (never re-issues).
  assert.strictEqual(isSessionStale(undefined, now, ttl), false);
});

test('expired session is rejected', () => {
  const auth = createAuth({ secret: 'test-secret' });
  const token = auth.signSession({ uid: 1, role: 'user', exp: Date.now() - 1, tokenVersion: 0 });
  assert.strictEqual(auth.parseToken(token), null);
});

// The shared team-password / break-glass login is gone: a session without a
// numeric uid must never validate, even when the signature is correct (the old
// "operator" and plain-number tokens of that era were signed the same way).
test('legacy uid=null and plain-number tokens are rejected despite a valid signature', () => {
  const secret = 'test-secret';
  const auth = createAuth({ secret });
  const signRaw = (bodyStr) => {
    const body = Buffer.from(bodyStr).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  };
  // old break-glass "operator" payload (uid=null)
  const operatorTok = signRaw(JSON.stringify({ exp: Date.now() + 60_000, uid: null, role: 'superuser', ver: 0 }));
  assert.strictEqual(auth.parseToken(operatorTok), null);
  // legacy plain-number body (pre-account era)
  const numberTok = signRaw(String(Date.now() + 60_000));
  assert.strictEqual(auth.parseToken(numberTok), null);
  // missing uid entirely
  const noUidTok = signRaw(JSON.stringify({ exp: Date.now() + 60_000, role: 'user', ver: 0 }));
  assert.strictEqual(auth.parseToken(noUidTok), null);
});

test('scrypt password hashes verify without exposing the password (async)', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$/);
  assert.strictEqual(stored.includes('correct horse'), false);
  // New 6-part format: scrypt$N$r$p$salt$hash.
  assert.strictEqual(stored.split('$').length, 6);
  assert.strictEqual(await verifyPassword('correct horse battery staple', stored), true);
  assert.strictEqual(await verifyPassword('wrong', stored), false);
});

test('verifyPassword accepts the legacy 3-part hash format (scrypt$salt$hash)', async () => {
  // Pre-parameterised rows stored `scrypt$<salt>$<hash>` with the default N/r/p; the async
  // verifier must still accept them byte-for-byte (no forced re-hash / lockout on migration).
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync('legacy secret', salt, 64, { N: 16384, r: 8, p: 1 });
  const legacy = `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
  assert.strictEqual(legacy.split('$').length, 3);
  assert.strictEqual(await verifyPassword('legacy secret', legacy), true);
  assert.strictEqual(await verifyPassword('nope', legacy), false);
});

test('verifyPassword is constant-cost / falsey against the anti-enumeration DUMMY_HASH', async () => {
  const { SCRYPT } = require('../server/lib/auth');
  const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  // Missing-user path verifies against DUMMY_HASH: must resolve false, never throw.
  assert.strictEqual(await verifyPassword('anything', DUMMY_HASH), false);
});

test('rate-limit key is per-user for sessions and per-IP otherwise', () => {
  const auth = createAuth({ secret: 'test-secret' });
  const userTok = auth.signSession({ uid: 42, role: 'user', exp: Date.now() + 60_000, tokenVersion: 0 });
  // authenticated → keyed by uid, independent of the (proxy-shared) IP
  assert.strictEqual(rateLimitKey(auth.parseToken(userTok), '203.0.113.9'), 'u:42');
  // forged/garbage token (parseToken → null) → per-IP, so token rotation can't escape the limit
  assert.strictEqual(rateLimitKey(auth.parseToken('garbage'), '198.51.100.7'), 'ip:198.51.100.7');
  assert.strictEqual(rateLimitKey(null, undefined), 'ip:unknown');
});
