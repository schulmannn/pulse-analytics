'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIgCrypto } = require('../server/lib/ig_crypto');
const { createTgCrypto } = require('../server/lib/tg_crypto');
const { createTgSessionDecryptor } = require('../server/lib/tgSessionDecrypt');

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

// ── Key rotation (previous read-only keys) ──────────────────────────────────────────────────────

test('active key round-trips and decryptDetailed does not report a previous key', () => {
  const c = createTgCrypto('active');
  const blob = c.encrypt('secret');
  assert.deepEqual(c.decryptDetailed(blob), { plaintext: 'secret', usedPreviousKey: false });
});

test('previous key decrypts a rotated-out blob (usedPreviousKey); encrypt uses ONLY the active key', () => {
  const oldOnly = createTgCrypto('old-key');
  const rotated = createTgCrypto('new-key', ['old-key']);

  // A blob written under the old key: the active (new) key can't authenticate it, so the rotated
  // instance transparently falls back to the previous key and flags it.
  const oldBlob = oldOnly.encrypt('session');
  assert.deepEqual(rotated.decryptDetailed(oldBlob), { plaintext: 'session', usedPreviousKey: true });
  assert.equal(rotated.decrypt(oldBlob), 'session');

  // A FRESH blob from the rotated instance is encrypted with only the active key, so the old-only
  // instance can no longer read it — this is what makes rotation actually rotate.
  const newBlob = rotated.encrypt('session');
  assert.deepEqual(rotated.decryptDetailed(newBlob), { plaintext: 'session', usedPreviousKey: false });
  assert.throws(() => oldOnly.decrypt(newBlob), 'old-only instance cannot read the re-encrypted blob');
});

test('multiple previous keys are tried in order', () => {
  const rotated = createTgCrypto('active', ['gen2', 'gen1']);
  const g1 = createTgCrypto('gen1').encrypt('s1');
  const g2 = createTgCrypto('gen2').encrypt('s2');
  assert.deepEqual(rotated.decryptDetailed(g1), { plaintext: 's1', usedPreviousKey: true });
  assert.deepEqual(rotated.decryptDetailed(g2), { plaintext: 's2', usedPreviousKey: true });
});

test('malformed blob → bad ciphertext; no key authenticates → throws without leaking material', () => {
  const c = createTgCrypto('ACTIVE-KEY', ['PREV-KEY']);
  assert.throws(() => c.decryptDetailed('not-a-valid-blob'), /bad ciphertext/);

  // A blob from an unrelated key authenticates with neither active nor previous.
  const alien = createTgCrypto('UNRELATED-KEY').encrypt('PLAINTEXT-XYZ');
  try {
    c.decryptDetailed(alien);
    assert.fail('should have thrown');
  } catch (e) {
    const msg = String(e.message);
    for (const secret of ['ACTIVE-KEY', 'PREV-KEY', 'UNRELATED-KEY', 'PLAINTEXT-XYZ', alien]) {
      assert.equal(msg.includes(secret), false, 'error message must not leak key/blob/plaintext');
    }
  }
});

test('previous keys alone (no active key) → not configured, encrypt still requires the active key', () => {
  const c = createTgCrypto('', ['prev']);
  assert.equal(c.configured(), false, 'previous keys must not enable the crypto');
  assert.throws(() => c.encrypt('x'), /TG_SESSION_KEY not set/);
});

test('IG crypto is active-only: no previous-key fallback, isolated from TG rotation', () => {
  const ig = createIgCrypto('IG-ACTIVE');           // IG never receives previous keys
  const tg = createTgCrypto('TG-ACTIVE', ['OLD-KEY']); // TG accepts a rotated-out key

  const oldBlob = createTgCrypto('OLD-KEY').encrypt('payload');
  // TG transparently reads the rotated-out blob via its previous key…
  assert.equal(tg.decryptDetailed(oldBlob).usedPreviousKey, true);
  // …but IG, being active-only, has no such fallback and cannot read it.
  assert.throws(() => ig.decrypt(oldBlob), 'active-only IG crypto has no previous-key channel');
});

test('lazy rewrite turns an old-key blob into active-only ciphertext with the same plaintext', async () => {
  const oldOnly = createTgCrypto('old-key');
  const activeOnly = createTgCrypto('new-key');
  const rotating = createTgCrypto('new-key', ['old-key']);
  const rewrites = [];
  const { decryptTgSession } = createTgSessionDecryptor({
    tgCrypto: rotating,
    db: {
      async rotateTgSessionCiphertext(uid, version, ciphertext) {
        rewrites.push({ uid, version, ciphertext });
        return true;
      },
    },
    log: () => {},
  });

  const plaintext = await decryptTgSession({
    uid: 5,
    session_version: '9',
    session_enc: oldOnly.encrypt('managed-session'),
  });
  assert.equal(plaintext, 'managed-session');
  assert.equal(rewrites.length, 1);
  assert.equal(rewrites[0].uid, 5);
  assert.equal(rewrites[0].version, '9');
  assert.equal(activeOnly.decrypt(rewrites[0].ciphertext), 'managed-session');
  assert.throws(() => oldOnly.decrypt(rewrites[0].ciphertext));
});
