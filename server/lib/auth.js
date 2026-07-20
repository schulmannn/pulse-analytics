'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const SCRYPT = { N: 16384, r: 8, p: 1 };
// Async scrypt keeps the derivation OFF the event loop (scryptSync blocks it for the whole
// N·r·p cost — under concurrent logins that stalls every other request). Same algorithm/params,
// so the stored hash format is byte-identical to the old scryptSync output.
const scryptAsync = promisify(crypto.scrypt);

function createAuth(options = {}) {
  const secret = options.secret || crypto.randomBytes(32).toString('hex');

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  function signSession({ uid, role, exp, tokenVersion = 0 }) {
    return sign({ uid, role, exp, ver: tokenVersion });
  }

  // Accounts only: a valid token always carries a numeric uid. Anything else —
  // malformed JSON, a legacy plain-number body, or an old uid=null "operator"
  // token — is rejected here, so callers can rely on session.uid being a number.
  function parseToken(token) {
    try {
      if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
      const [body, signature] = token.split('.');
      const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
      if (!signature || signature.length !== expected.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || !Number.isInteger(payload.uid)) return null;
      if (!payload.exp || payload.exp <= Date.now()) return null;
      return {
        uid: payload.uid,
        role: payload.role || 'user',
        tokenVersion: Number.isInteger(payload.ver) ? payload.ver : 0,
        exp: payload.exp, // caller uses this to slide the session (re-issue past half-life)
      };
    } catch (_) {
      return null;
    }
  }

  return { signSession, parseToken };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(password), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
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
    // Constant-cost even for a missing user: callers hash against DUMMY_HASH so the scrypt work
    // still runs (kills the "skip the hash" enumeration timing oracle).
    const actual = await scryptAsync(String(password), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

// Rate-limit bucket key for the general /api limiter. Authenticated requests are
// keyed per user (uid) — stable across token refreshes and isolated from other
// users; unauthenticated/forged-token requests fall back to a per-IP bucket.
// `session` is the parseToken() result (or null) — a non-null session always
// carries a numeric uid.
function rateLimitKey(session, ip) {
  if (session) return `u:${session.uid}`;
  return `ip:${ip || 'unknown'}`;
}

// Sliding-session staleness: true once a token is past its half-life, so requireAuth can hand the
// client a fresh full-TTL token and an active user is never logged out mid-work. Pure + exported so
// the exact predicate is unit-guarded. A token without a numeric exp is treated as not-stale (no-op).
function isSessionStale(exp, now, ttl) {
  return typeof exp === 'number' && exp - now < ttl / 2;
}

// ── Cookie-транспорт сессии (cookie-auth, фаза 1) ────────────────────────────
// Тот же stateless-HMAC-токен, но доставленный HttpOnly-cookie. Header-путь
// (X-Session-Token) остаётся каноном для SPA/legacy; cookie читается ТОЛЬКО когда
// заголовка нет. Хелперы чистые + экспортированы, чтобы точный контракт (парсинг,
// атрибуты Set-Cookie, CSRF-предикат) был unit-заперт — как isSessionStale выше.
const SESSION_COOKIE = 'pulse_session';

// Значение cookie из сырого заголовка Cookie (без cookie-parser — как cookieValue в
// ig-oauth). Токен — base64url + точка, percent-encoding при записи не используется,
// поэтому значение возвращается как есть (декодирование не нужно).
function readCookie(header, name) {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

// Строка Set-Cookie сессии: HttpOnly (не читается из JS — токен не утекает через XSS),
// SameSite=Lax (cookie не уходит с кросс-сайтовым POST), Path=/. Max-Age — серверный
// срок токена (SESSION_TTL, мс → сек). Secure — по флагу (req.secure: за Railway-прокси
// true, на локальном http — нет). Пустой token + maxAgeMs=0 = сброс cookie (logout).
function serializeSessionCookie(token, { secure, maxAgeMs }) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// CSRF-предикат для мутаций, аутентифицированных через cookie: браузер шлёт cookie сам,
// поэтому требуем доказательство same-origin — Origin равен origin запроса; при
// отсутствии Origin допустим Referer с тем же origin; иначе false (403). Присутствующий,
// но чужой Origin НЕ падает на Referer-фоллбек. Header-аутентифицированные запросы сюда
// не заходят вовсе: кастомный заголовок сам по себе CSRF-барьер.
function isCsrfSafe({ origin, referer, requestOrigin }) {
  if (origin) return origin === requestOrigin;
  if (referer) {
    try { return new URL(referer).origin === requestOrigin; } catch { return false; }
  }
  return false;
}

module.exports = {
  createAuth, hashPassword, verifyPassword, SCRYPT, rateLimitKey, isSessionStale,
  SESSION_COOKIE, readCookie, serializeSessionCookie, isCsrfSafe,
};
