'use strict';

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };

function createAuth(options = {}) {
  const secret = options.secret || crypto.randomBytes(32).toString('hex');

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  function signBreakGlass(expires) {
    return sign({ exp: expires, uid: null, role: 'superuser', ver: 0 });
  }

  function signSession({ uid, role, exp, tokenVersion = 0 }) {
    return sign({ uid, role, exp, ver: tokenVersion });
  }

  function parseToken(token) {
    try {
      if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
      const [body, signature] = token.split('.');
      const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
      if (!signature || signature.length !== expected.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
      const decoded = Buffer.from(body, 'base64url').toString('utf8');
      let payload;
      if (decoded[0] === '{') payload = JSON.parse(decoded);
      else payload = { exp: parseInt(decoded, 10), uid: null, role: 'superuser', ver: 0 };
      if (!payload.exp || payload.exp <= Date.now()) return null;
      return {
        uid: payload.uid == null ? null : payload.uid,
        role: payload.role || 'user',
        tokenVersion: Number.isInteger(payload.ver) ? payload.ver : 0,
      };
    } catch (_) {
      return null;
    }
  }

  return { signBreakGlass, signSession, parseToken };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  let N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p, saltHex, hashHex;
  if (parts.length === 6) {
    N = +parts[1]; r = +parts[2]; p = +parts[3]; saltHex = parts[4]; hashHex = parts[5];
  } else if (parts.length === 3) {
    saltHex = parts[1]; hashHex = parts[2];
  } else {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (!salt.length || !expected.length) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

// Rate-limit bucket key for the general /api limiter. Authenticated requests are
// keyed per user (uid) — stable across token refreshes and isolated from other
// users; break-glass (no uid) and unauthenticated/forged-token requests fall back
// to a per-IP bucket. `session` is the parseToken() result (or null).
function rateLimitKey(session, ip) {
  if (session) return session.uid != null ? `u:${session.uid}` : `op:${ip || 'x'}`;
  return `ip:${ip || 'unknown'}`;
}

module.exports = { createAuth, hashPassword, verifyPassword, SCRYPT, rateLimitKey };
