// Cookie-auth фаза 1 (P1 арх-разбора): requireAuth принимает HttpOnly-cookie
// pulse_session НАРЯДУ с заголовком X-Session-Token (заголовок приоритетнее),
// login/sliding-refresh ставят Set-Cookie, cookie-мутации гейтятся same-origin
// CSRF-проверкой. Реальный Express + стаб db (паттерн http_smoke, но без composition —
// сервис собирается напрямую, чтобы управлять token_version/exp из теста).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAuthService } = require('../server/services/authService');
const { registerAuthRoutes } = require('../server/routes/auth');
const { hashPassword, verifyPassword, SESSION_COOKIE } = require('../server/lib/auth');

const PASSWORD = 'correct horse battery';
const user = { id: 7, email: 'u@example.com', role: 'user', status: 'active', token_version: 0, pass_hash: '' };
const db = {
  enabled: true,
  getUserById: async (id) => (id === user.id ? { ...user } : null),
  getUserByEmail: async (email) => (email === user.email ? { ...user } : null),
  getUserAvatar: async () => null,
  revokeUserSessions: async () => { user.token_version += 1; },
};

const svc = createAuthService({
  config: { auth: { sessionSecret: 'test-cookie-secret', adminEmail: null, adminPassword: null, googleClientId: null } },
  db,
});

let server;
let baseUrl;

// Свежий валидный токен с ЖИВЫМ token_version (тесты не зависят от порядка logout'а).
const freshToken = (over = {}) => svc.signSession({
  uid: user.id, role: user.role, exp: Date.now() + svc.SESSION_TTL, tokenVersion: user.token_version, ...over,
});
const cookieOf = (token) => `${SESSION_COOKIE}=${token}`;
const sessionSetCookie = (res) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) || null;

test.before(async () => {
  user.pass_hash = await hashPassword(PASSWORD);
  const app = express();
  // Как за Railway: доверенный прокси-хоп, чтобы X-Forwarded-Proto: https дал req.secure.
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
    GOOGLE_CLIENT_ID: null,
    fetchWithTimeout: async () => { throw new Error('сеть в тесте запрещена'); },
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
    escHtml: (s) => String(s),
    aiEnabledFor: () => false,
    setSessionCookie: svc.setSessionCookie,
    clearSessionCookie: svc.clearSessionCookie,
  });
  // Тестовые поверхности за requireAuth: чтение и мутация — для CSRF-матрицы.
  app.get('/api/echo', svc.requireAuth, (req, res) => res.json({ uid: req.user.uid }));
  app.post('/api/echo', svc.requireAuth, (req, res) => res.json({ ok: true, uid: req.user.uid }));
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
  });
});

test('login ставит Set-Cookie pulse_session с HttpOnly/Lax/Path=/ и серверным TTL', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token, 'JSON-контракт header-клиентов не изменился');
  const cookie = sessionSetCookie(res);
  assert.ok(cookie, 'login несёт Set-Cookie pulse_session');
  // cookie дублирует ровно тот же токен, что ушёл в JSON
  assert.strictEqual(cookie.split(';')[0], `${SESSION_COOKIE}=${body.token}`);
  assert.match(cookie, /; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.ok(!/; Secure/.test(cookie), 'на голом http без Secure');
});

test('login за https-прокси (X-Forwarded-Proto) добавляет Secure', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  assert.match(sessionSetCookie(res), /; Secure$/);
});

test('GET с cookie без заголовка аутентифицируется', async () => {
  const res = await fetch(`${baseUrl}/api/echo`, { headers: { Cookie: cookieOf(freshToken()) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { uid: user.id });
});

test('битая cookie без заголовка → 401', async () => {
  const res = await fetch(`${baseUrl}/api/echo`, { headers: { Cookie: cookieOf('garbage') } });
  assert.equal(res.status, 401);
});

test('CSRF-матрица: cookie-мутация требует same-origin Origin/Referer', async () => {
  const Cookie = cookieOf(freshToken());
  const post = (extra = {}) => fetch(`${baseUrl}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie, ...extra },
    body: '{}',
  });
  // без Origin/Referer → 403 {error:'csrf'}
  let res = await post();
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'csrf' });
  // корректный Origin → ok
  res = await post({ Origin: baseUrl });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, uid: user.id });
  // чужой Origin → 403 (Referer с верным origin не спасает)
  res = await post({ Origin: 'https://evil.example', Referer: `${baseUrl}/page` });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'csrf' });
  // Origin нет, но same-origin Referer есть → ok
  res = await post({ Referer: `${baseUrl}/page?x=1` });
  assert.equal(res.status, 200);
});

test('мутация с header-токеном без Origin → ok (header сам по себе CSRF-барьер)', async () => {
  const res = await fetch(`${baseUrl}/api/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': freshToken() },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, uid: user.id });
});

test('заголовок приоритетнее cookie: валидный header + битая cookie → ok, битый header + валидная cookie → 401', async () => {
  let res = await fetch(`${baseUrl}/api/echo`, {
    headers: { 'X-Session-Token': freshToken(), Cookie: cookieOf('broken.token') },
  });
  assert.equal(res.status, 200);
  // header объявил намерение и проиграл — на cookie не падаем
  res = await fetch(`${baseUrl}/api/echo`, {
    headers: { 'X-Session-Token': 'broken.token', Cookie: cookieOf(freshToken()) },
  });
  assert.equal(res.status, 401);
});

test('sliding-refresh обновляет cookie тем же токеном, что и X-Session-Refresh', async () => {
  // токен за половиной жизни → requireAuth обязан переиздать
  const stale = freshToken({ exp: Date.now() + svc.SESSION_TTL / 2 - 60_000 });
  for (const headers of [
    { Cookie: cookieOf(stale) },                 // cookie-транспорт
    { 'X-Session-Token': stale },                // header-транспорт — cookie тоже едет
  ]) {
    const res = await fetch(`${baseUrl}/api/echo`, { headers });
    assert.equal(res.status, 200);
    const fresh = res.headers.get('x-session-refresh');
    assert.ok(fresh, 'X-Session-Refresh уходит как раньше');
    const cookie = sessionSetCookie(res);
    assert.ok(cookie, 'refresh дополнительно ставит cookie');
    assert.strictEqual(cookie.split(';')[0], `${SESSION_COOKIE}=${fresh}`);
    assert.match(cookie, /; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/);
  }
});

test('logout чистит cookie (Max-Age=0) — cookie-мутация проходит с Origin', async () => {
  const res = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOf(freshToken()), Origin: baseUrl },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(sessionSetCookie(res), new RegExp(`^${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax$`));
});

test('Sec-Fetch-Site: cross-site гасит cookie-транспорт целиком (и GET — квотные роуты)', async () => {
  // Lax-cookie едет на кросс-сайтовых top-level GET-навигациях — атакующая страница цепочкой
  // переходов сжигала бы квотные GET (searchPosts ~10/день, живые МС-отчёты). Современные
  // браузеры шлют Sec-Fetch-Site — cross-site с cookie-транспортом = 401 без чтения токена.
  const res = await fetch(`${baseUrl}/api/echo`, {
    headers: { Cookie: cookieOf(freshToken()), 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(res.status, 401);
  // same-origin / none (адресная строка, закладка) — работают.
  for (const site of ['same-origin', 'none']) {
    const ok = await fetch(`${baseUrl}/api/echo`, {
      headers: { Cookie: cookieOf(freshToken()), 'Sec-Fetch-Site': site },
    });
    assert.equal(ok.status, 200, `Sec-Fetch-Site: ${site}`);
  }
  // Header-транспорт кросс-сайтовым быть не может (кастомный заголовок = CORS-барьер) — не гейтится.
  const viaHeader = await fetch(`${baseUrl}/api/echo`, {
    headers: { 'X-Session-Token': freshToken(), 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(viaHeader.status, 200);
});
