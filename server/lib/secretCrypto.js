'use strict';

const crypto = require('crypto');

function deriveKey(rawKey) {
  const raw = String(rawKey || '');
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function createSecretCrypto({ rawKey, missingKeyMessage }) {
  const key = deriveKey(rawKey);

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

  function decrypt(blob) {
    const activeKey = requireKey();
    const [ivHex, tagHex, dataHex] = String(blob).split(':');
    if (!ivHex || !tagHex || !dataHex) throw new Error('bad ciphertext');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      activeKey,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }

  return Object.freeze({ configured, encrypt, decrypt });
}

module.exports = { createSecretCrypto, deriveKey };
