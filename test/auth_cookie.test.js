// Cookie-only auth contract: ordinary API accepts only pulse_session, the
// one-release migrate-cookie route is the sole X-Session-Token bridge, mutations
// require same-origin proof, refresh never exposes tokens to JavaScript, and
// idle sliding stays inside an absolute deadline.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createAuthService } = require('../server/services/authService');
const { registerAuthRoutes } = require('../server/routes/auth');
const { hashPassword, verifyPassword, SESSION_COOKIE } = require('../server/lib/auth');

const PASSWORD = 'correct horse battery';
const SESSION_SECRET = 'test-cookie-secret';
const user = {
  id: 7,
  email: 'u@example.com',
  role: 'user',
  status: 'active',
  token_version: 0,
  pass_hash: '',
};

const db = {
  enabled: true,
  getUserById: async (id) => (id === user.id ? { ...user } : null),
  getUserByEmail: async (email) => (email === user.email ? { ...user } : null),
  getUserAvatar: async () => null,
  revokeUserSessions: async () => {
    user.token_version += 1;
    return true;
  },
  setUserPassword: async (id, passHash) => {
    if (id !== user.id) return false;
    user.pass_hash = passHash;
    user.token_version += 1;
    return true;
  },
  setUserStatus: async (id, status) => {
    if (id !== user.id) return null;
    user.status = status;
    user.token_version += 1;
    return { ...user };
  },
  useEmailToken: async (_hash, kind) => (kind === 'reset' ? { uid: user.id } : null),
  // Транзакционный consume (аудит P1): роут /api/auth/reset сжигает токен и меняет пароль одним
  // методом; стаб зеркалит контракт — пароль и token_version меняются вместе.
  consumeResetTokenAndSetPassword: async (_hash, passHash) => {
    user.pass_hash = passHash;
    user.token_version += 1;
    return { uid: user.id };
  },
};

const svc = createAuthService({
  config: {
    auth: {
      sessionSecret: SESSION_SECRET,
      sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
      sessionAbsoluteTtlMs: 30 * 24 * 60 * 60 * 1000,
      adminEmail: null,
      adminPassword: null,
      googleClientId: 'google-client',
    },
  },
  db,
});

let server;
let baseUrl;

const freshToken = (over = {}) => {
  const now = Date.now();
  return svc.signSession({
    uid: user.id,
    role: user.role,
    exp: now + svc.SESSION_TTL,
    maxExp: now + svc.SESSION_ABSOLUTE_TTL,
    tokenVersion: user.token_version,
    ...over,
  });
};

function legacyToken(over = {}) {
  const payload = {
    uid: user.id,
    role: user.role,
    exp: Date.now() + svc.SESSION_TTL,
    ver: user.token_version,
    ...over,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

const cookieOf = (token) => `${SESSION_COOKIE}=${token}`;
const sessionSetCookie = (res) =>
  res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)) || null;
const cookieToken = (setCookie) => setCookie.split(';')[0].slice(`${SESSION_COOKIE}=`.length);

test.before(async () => {
  user.pass_hash = await hashPassword(PASSWORD);
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const pass = (_req, _res, next) => next();
  registerAuthRoutes({
    app,
    express,
    db,
    requireAuth: svc.requireAuth,
    authLimiter: pass,
    asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
    hashPassword,
    verifyPassword,
    DUMMY_HASH: svc.DUMMY_HASH,
    signSession: svc.signSession,
    SESSION_TTL: svc.SESSION_TTL,
    SESSION_ABSOLUTE_TTL: svc.SESSION_ABSOLUTE_TTL,
    GOOGLE_CLIENT_ID: 'google-client',
    fetchWithTimeout: async () => Response.json({
      sub: 'google-sub',
      aud: 'google-client',
      iss: 'https://accounts.google.com',
      email_verified: 'true',
      email: user.email,
    }),
    log: () => {},
    audit: async () => {},
    appBase: () => baseUrl,
    sha256: svc.sha256,
    newToken: svc.newToken,
    VERIFY_TTL: svc.VERIFY_TTL,
    RESET_TTL: svc.RESET_TTL,
    sendEmail: async () => {},
    emailShell: () => '',
    emailBtn: () => '',
    escHtml: String,
    aiEnabledFor: () => false,
    migrateSessionCookie: svc.migrateSessionCookie,
    setSessionCookie: svc.setSessionCookie,
    clearSessionCookie: svc.clearSessionCookie,
  });
  app.get('/api/echo', svc.requireAuth, (req, res) => res.json({ uid: req.user.uid }));
  app.post('/api/echo', svc.requireAuth, (req, res) =>
    res.json({ ok: true, uid: req.user.uid }));
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('login sets HttpOnly cookie and returns no browser-readable token', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    user: { email: user.email, role: user.role },
  });
  const cookie = sessionSetCookie(res);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/);
  const parsed = svc.parseToken(cookieToken(cookie));
  assert.ok(parsed.maxExp - Date.now() > 29 * 24 * 60 * 60 * 1000);
});

test('login behind https proxy adds Secure', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  assert.match(sessionSetCookie(res), /; Secure$/);
});

test('Google login also returns only ok/user and sets the cookie', async () => {
  const res = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: 'google-id-token' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    user: { email: user.email, role: user.role },
  });
  assert.ok(sessionSetCookie(res));
});

test('ordinary API is cookie-only and ignores X-Session-Token', async () => {
  let res = await fetch(`${baseUrl}/api/echo`, {
    headers: { 'X-Session-Token': freshToken() },
  });
  assert.equal(res.status, 401, 'header-only auth is rejected');

  res = await fetch(`${baseUrl}/api/echo`, {
    headers: {
      Cookie: cookieOf(freshToken()),
      'X-Session-Token': 'broken.header.is-ignored',
    },
  });
  assert.equal(res.status, 200, 'ordinary route reads only the valid cookie');
  assert.deepEqual(await res.json(), { uid: user.id });
});

test('migrate-cookie is the narrow same-origin legacy bridge', async () => {
  const token = legacyToken();
  let res = await fetch(`${baseUrl}/api/auth/migrate-cookie`, {
    method: 'POST',
    headers: { 'X-Session-Token': token },
  });
  assert.equal(res.status, 403, 'missing same-origin proof fails closed');

  const started = Date.now();
  res = await fetch(`${baseUrl}/api/auth/migrate-cookie`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'X-Session-Token': token,
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const cookie = sessionSetCookie(res);
  const parsed = svc.parseToken(cookieToken(cookie));
  assert.equal(parsed.legacyAbsolute, false);
  assert.ok(parsed.exp >= started + svc.SESSION_TTL - 1000);
  assert.ok(parsed.maxExp <= Date.now() + svc.SESSION_TTL);
  assert.equal(parsed.exp, parsed.maxExp, 'legacy bridge receives one bounded full idle window');

  res = await fetch(`${baseUrl}/api/auth/migrate-cookie`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'Sec-Fetch-Site': 'cross-site',
      'X-Session-Token': legacyToken(),
    },
  });
  assert.equal(res.status, 403);
});

test('migration validates current token_version and active user', async () => {
  const res = await fetch(`${baseUrl}/api/auth/migrate-cookie`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'X-Session-Token': legacyToken({ ver: user.token_version - 1 }),
    },
  });
  assert.equal(res.status, 401);
  assert.equal(sessionSetCookie(res), null);
});

test('cookie mutation requires same-origin Origin or Referer', async () => {
  const Cookie = cookieOf(freshToken());
  const post = (extra = {}) => fetch(`${baseUrl}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie, ...extra },
    body: '{}',
  });
  let res = await post();
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'csrf' });
  res = await post({ Origin: baseUrl });
  assert.equal(res.status, 200);
  res = await post({ Referer: `${baseUrl}/home` });
  assert.equal(res.status, 200);
  res = await post({ Origin: 'https://evil.example', Referer: `${baseUrl}/home` });
  assert.equal(res.status, 403);
});

test('sliding refresh rotates only Set-Cookie and preserves absolute maxExp', async () => {
  const now = Date.now();
  const maxExp = now + 10 * 24 * 60 * 60 * 1000;
  const stale = freshToken({
    exp: now + svc.SESSION_TTL / 2 - 60_000,
    maxExp,
  });
  const res = await fetch(`${baseUrl}/api/echo`, {
    headers: { Cookie: cookieOf(stale) },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-session-refresh'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const parsed = svc.parseToken(cookieToken(sessionSetCookie(res)));
  assert.equal(parsed.maxExp, maxExp);
  assert.ok(parsed.exp <= maxExp);
  assert.ok(parsed.exp > now + 6 * 24 * 60 * 60 * 1000);
});

/** Числовой Max-Age из строки Set-Cookie: сравнение диапазоном, а не совпадением цифр. */
function maxAgeOf(cookie) {
  const m = /(?:^|;\s*)Max-Age=(\d+)/i.exec(String(cookie || ''));
  assert.ok(m, `в cookie нет Max-Age: ${cookie}`);
  return Number(m[1]);
}

test('sliding refresh cannot move beyond the absolute deadline', async () => {
  const now = Date.now();
  const maxExp = now + 2 * 24 * 60 * 60 * 1000;
  const res = await fetch(`${baseUrl}/api/echo`, {
    headers: {
      Cookie: cookieOf(freshToken({ exp: maxExp, maxExp })),
    },
  });
  assert.equal(res.status, 200);
  const cookie = sessionSetCookie(res);
  assert.ok(cookie);
  const parsed = svc.parseToken(cookieToken(cookie));
  assert.equal(parsed.exp, maxExp);
  assert.equal(parsed.maxExp, maxExp);
  // Max-Age считается сервером как floor((exp - его Date.now()) / 1000). Если запрос попал в ТУ ЖЕ
  // миллисекунду, что и Date.now() теста, получается ровно 172800 — и регулярка /1727\d\d/ не
  // совпадала. Именно так упал push-прогон main для #552. Проверяем числом и диапазоном.
  const maxAge = maxAgeOf(cookie);
  assert.ok(maxAge > 172_700 && maxAge <= 172_800,
    `Max-Age=${maxAge} вне окна абсолютного дедлайна (172700, 172800]`);
});

test('logout revokes sessions and clears the cookie', async () => {
  const before = freshToken();
  const res = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieOf(before),
      Origin: baseUrl,
    },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(
    sessionSetCookie(res),
    new RegExp(`^${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax$`),
  );
  const rejected = await fetch(`${baseUrl}/api/echo`, {
    headers: { Cookie: cookieOf(before) },
  });
  assert.equal(rejected.status, 401);
  assert.match(sessionSetCookie(rejected), /Max-Age=0/);
});

test('change-password revokes old sessions and rotates the current cookie', async () => {
  user.pass_hash = await hashPassword(PASSWORD);
  const oldVersion = user.token_version;
  const res = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieOf(freshToken()),
      Origin: baseUrl,
    },
    body: JSON.stringify({ current: PASSWORD, next: 'new password value' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(user.token_version, oldVersion + 1);
  const parsed = svc.parseToken(cookieToken(sessionSetCookie(res)));
  assert.equal(parsed.tokenVersion, user.token_version);
  user.pass_hash = await hashPassword(PASSWORD);
});

test('password reset clears any existing browser cookie', async () => {
  const res = await fetch(`${baseUrl}/api/auth/reset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieOf(freshToken()),
    },
    body: JSON.stringify({ token: 'email-reset-token', password: 'reset password value' }),
  });
  assert.equal(res.status, 200);
  assert.match(sessionSetCookie(res), /Max-Age=0/);
  user.pass_hash = await hashPassword(PASSWORD);
});

test('Sec-Fetch-Site cross-site rejects even a safe-method cookie request', async () => {
  const res = await fetch(`${baseUrl}/api/echo`, {
    headers: {
      Cookie: cookieOf(freshToken()),
      'Sec-Fetch-Site': 'cross-site',
    },
  });
  assert.equal(res.status, 401);
});
