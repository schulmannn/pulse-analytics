// Google-вход и статусы аккаунта (аудит P1): табличный контракт по всем четырём статусам.
// Google подтверждает владение EMAIL, но не заменяет одобрение администратора: 'pending' обязан
// получать тот же 403, что и обычный логин (раньше любой не-disabled статус молча становился
// active — обход approval-флоу). Автоактивация допустима ТОЛЬКО для 'unverified' (нейтрализация
// pre-hijack: пароль затирается, token_version бампается). Новый email создаёт active-аккаунт.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAuthService } = require('../server/services/authService');
const { registerAuthRoutes } = require('../server/routes/auth');
const { hashPassword, verifyPassword, SESSION_COOKIE } = require('../server/lib/auth');

const SESSION_SECRET = 'google-status-secret';
const GOOGLE_EMAIL = 'g@example.com';

// Мутабельный стаб-пользователь: каждый кейс таблицы пересаживает status/поля заново.
let user = null;
let created = null;

const db = {
  enabled: true,
  getUserById: async (id) => (user && id === user.id ? { ...user } : null),
  getUserByEmail: async (email) => (user && email === user.email ? { ...user } : null),
  getUserAvatar: async () => null,
  createUser: async ({ email, pass_hash, role, status }) => {
    created = { id: 99, email, pass_hash, role, status, token_version: 0 };
    return { ...created };
  },
  setUserPassword: async (id, passHash) => {
    if (!user || id !== user.id) return false;
    user.pass_hash = passHash;
    user.token_version += 1;
    return true;
  },
  setUserStatus: async (id, status) => {
    if (!user || id !== user.id) return null;
    user.status = status;
    user.token_version += 1;
    return { ...user };
  },
  clearUserCreatedVia: async (id) => {
    if (!user || id !== user.id || user.created_via == null) return false;
    user.created_via = null;
    return true;
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

test.before(async () => {
  const app = express();
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
    // Валидный Google-ответ всегда: таблица ниже проверяет ИМЕННО статусные ветки, не токен.
    fetchWithTimeout: async () => Response.json({
      sub: 'google-sub',
      aud: 'google-client',
      iss: 'https://accounts.google.com',
      email_verified: 'true',
      email: GOOGLE_EMAIL,
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
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

const googleLogin = () =>
  fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ credential: 'stub-google-jwt' }),
  });

const sessionCookie = (res) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) || null;

const seed = async (status, extra = {}) => {
  created = null;
  user = {
    id: 7,
    email: GOOGLE_EMAIL,
    role: 'user',
    status,
    token_version: 3,
    pass_hash: await hashPassword('pre-seeded password'),
    created_via: null,
    ...extra,
  };
};

test('google: pending НЕ активируется — 403 без сессии, статус и token_version нетронуты', async () => {
  await seed('pending');
  const res = await googleLogin();
  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /одобрения администратором/);
  assert.strictEqual(sessionCookie(res), null, 'сессия не должна выпускаться');
  assert.strictEqual(user.status, 'pending', 'статус не должен меняться');
  assert.strictEqual(user.token_version, 3);
});

test('google: disabled → 403 без сессии', async () => {
  await seed('disabled');
  const res = await googleLogin();
  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /отключён/);
  assert.strictEqual(sessionCookie(res), null);
  assert.strictEqual(user.status, 'disabled');
});

test('google: unverified активируется (владение доказано), pre-seeded пароль затирается', async () => {
  await seed('unverified');
  const preHash = user.pass_hash;
  const res = await googleLogin();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).user, { email: GOOGLE_EMAIL, role: 'user' });
  assert.ok(sessionCookie(res), 'успешный вход выпускает cookie-сессию');
  assert.strictEqual(user.status, 'active');
  assert.notStrictEqual(user.pass_hash, preHash, 'пароль атакующего-пререгистратора нейтрализован');
  assert.ok(user.token_version > 3, 'старые сессии отозваны');
});

test('google: active входит как есть — без смены пароля/статуса', async () => {
  await seed('active');
  const preHash = user.pass_hash;
  const res = await googleLogin();
  assert.strictEqual(res.status, 200);
  assert.ok(sessionCookie(res));
  assert.strictEqual(user.status, 'active');
  assert.strictEqual(user.pass_hash, preHash, 'пароль активного аккаунта не трогаем');
  assert.strictEqual(user.token_version, 3);
});

test('google: новый email создаёт active-аккаунт с непригодным паролем', async () => {
  created = null;
  user = null;
  const res = await googleLogin();
  assert.strictEqual(res.status, 200);
  assert.ok(sessionCookie(res));
  assert.ok(created, 'аккаунт создан');
  assert.strictEqual(created.status, 'active');
  assert.strictEqual(await verifyPassword('пусто', created.pass_hash), false);
});

// ── H-1: аккаунт, заведённый публичным /claim по ссылке приглашения ───────────────────────────────
// До правки такой аккаунт выпускался сразу ACTIVE с паролем, который выбрал ОТКРЫВШИЙ ссылку — а её
// сервер отдавал приглашающему. Вход настоящего владельца через Google обязан обезвредить чужой
// доступ: пароль на случайный, все прежние сессии отозваны. Пометка снимается — защита нужна раз.
test('google: active-аккаунт из invite_claim обезвреживается при первом входе владельца', async () => {
  await seed('active', { created_via: 'invite_claim' });
  const preHash = user.pass_hash;
  const res = await googleLogin();
  assert.strictEqual(res.status, 200);
  assert.ok(sessionCookie(res), 'владелец входит');
  assert.notStrictEqual(user.pass_hash, preHash, 'пароль открывшего ссылку нейтрализован');
  assert.ok(user.token_version > 3, 'cookie атакующего отозвана');
  assert.strictEqual(user.created_via, null, 'пометка снята — повторный вход пароль уже не трогает');
  assert.strictEqual(user.status, 'active');
});

test('google: повторный вход после обезвреживания ничего не трогает', async () => {
  await seed('active', { created_via: null });
  const preHash = user.pass_hash;
  const res = await googleLogin();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(user.pass_hash, preHash);
  assert.strictEqual(user.token_version, 3);
});
