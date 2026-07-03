'use strict';

// Authenticated symmetric encryption for Telegram StringSession secrets at rest (AES-256-GCM).
// A StringSession grants FULL access to the user's Telegram account, so it is never stored or
// logged in plaintext. Mirrors lib/ig_crypto: the key comes from TG_SESSION_KEY — a 64-char hex
// string is used verbatim (32 bytes); any other non-empty value is SHA-256'd into a stable
// 32-byte key. Ciphertext format is `ivHex:tagHex:cipherHex` so a single TEXT column round-trips.

const crypto = require('crypto');

function getKey() {
  const raw = process.env.TG_SESSION_KEY || '';
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/** True when TG_SESSION_KEY is configured (session encryption available). */
function configured() {
  return !!getKey();
}

/** Encrypt a plaintext session string → "ivHex:tagHex:cipherHex". Throws if no key. */
function encrypt(plain) {
  const key = getKey();
  if (!key) throw new Error('TG_SESSION_KEY not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/** Decrypt "ivHex:tagHex:cipherHex" → plaintext. Throws if no key or on tamper. */
function decrypt(blob) {
  const key = getKey();
  if (!key) throw new Error('TG_SESSION_KEY not set');
  const [ivHex, tagHex, dataHex] = String(blob).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('bad ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { configured, encrypt, decrypt };
