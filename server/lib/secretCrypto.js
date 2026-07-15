'use strict';

const crypto = require('crypto');

function deriveKey(rawKey) {
  const raw = String(rawKey || '');
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

// Split a stored blob into its hex parts ONCE. Returns null for anything malformed (missing part) so
// callers preserve today's `bad ciphertext` semantics without re-parsing per candidate key.
function parseBlob(blob) {
  const [ivHex, tagHex, dataHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  return { ivHex, tagHex, dataHex };
}

// Attempt AES-256-GCM decrypt with ONE key. Throws on auth failure (wrong key / tampered blob) — the
// node error is a static string, so it carries no key/blob/plaintext material.
function decryptWith(k, parts) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(parts.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(parts.tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts.dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

// `previousRawKeys` — optional, ordered read-only keys tried (in order) ONLY when the active key fails
// to authenticate a blob (key-rotation support). encrypt() always uses the active primary; with no
// previous keys the instance is byte-for-byte the pre-rotation crypto.
function createSecretCrypto({ rawKey, previousRawKeys = [], missingKeyMessage }) {
  const key = deriveKey(rawKey);
  const previousKeys = (Array.isArray(previousRawKeys) ? previousRawKeys : [])
    .map(deriveKey)
    .filter(Boolean);

  function configured() {
    return !!key;
  }

  function requireKey() {
    if (!key) throw new Error(missingKeyMessage);
    return key;
  }

  function encrypt(plain) {
    const activeKey = requireKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', activeKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(String(plain), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  // Detailed decrypt: parse once, try the ACTIVE key first, then each PREVIOUS key in order. Returns
  // `{ plaintext, usedPreviousKey }` — `usedPreviousKey` tells the caller a rotated-out key was needed
  // (so it can lazily re-encrypt under the active key). Malformed blob → `bad ciphertext`; if no key
  // authenticates, the active key's failure is re-thrown (today's safe failure — no secret material).
  function decryptDetailed(blob) {
    const activeKey = requireKey();
    const parts = parseBlob(blob);
    if (!parts) throw new Error('bad ciphertext');
    let activeErr;
    try {
      return { plaintext: decryptWith(activeKey, parts), usedPreviousKey: false };
    } catch (e) {
      activeErr = e;
    }
    for (const prev of previousKeys) {
      try {
        return { plaintext: decryptWith(prev, parts), usedPreviousKey: true };
      } catch {
        // wrong previous key — keep trying the remaining ones
      }
    }
    throw activeErr;
  }

  function decrypt(blob) {
    return decryptDetailed(blob).plaintext;
  }

  return Object.freeze({ configured, encrypt, decrypt, decryptDetailed });
}

module.exports = { createSecretCrypto, deriveKey };
