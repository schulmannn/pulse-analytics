'use strict';

// ReDoS в проверке email (аудит, AUTH-1). Прежний паттерн `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` разбирал
// строку «a@» + точки + «@» бэктрекингом за O(n²): тело в 100 КБ (предел express.json) держало
// единственный Node-процесс ~20 с на один анонимный POST /api/auth/register или /forgot.
//
// Здесь пришпилены две вещи: контракт общей проверки (lib/emailAddress — обычные адреса как
// раньше, длина режется до регулярки, разбор линеен) и то, что публичные роуты auth ходят именно
// через неё — с прежними ответами и прежним порядком «сначала ответ, потом БД» у forgot/resend.
// Бюджет времени щедрый (200 мс против ~20 с у прежнего паттерна), чтобы параллельный прогон
// юнитов не делал тест хрупким.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const { isPlausibleEmail, MAX_EMAIL_LENGTH } = require('../server/lib/emailAddress');
const { registerAuthRoutes } = require('../server/routes/auth');

const BUDGET_MS = 200;

// Тело атаки из аудита: `{"email":"a@" + "."×102300 + "@"}` — 102 КБ, express.json его пропускает.
const ATTACK = `a@${'.'.repeat(102_300)}@`;
// Соседние формы той же идеи: пусть ни одна не найдёт у нового паттерна неоднозначного места.
const PATHOLOGICAL = {
  'точки подряд': ATTACK,
  'метки через точку без хвоста': `a@${'b.'.repeat(51_150)}@`,
  'метки и пробел в конце': `a@${'b.'.repeat(51_150)} `,
  'двойные точки': `a@${'bb..'.repeat(25_575)}@`,
  'длинная локальная часть': `${'a'.repeat(102_300)}@`,
  'много собачек': 'a@'.repeat(51_150),
};

const timed = (fn) => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

// ── Контракт проверки ─────────────────────────────────────────────────────────────────────────────
test('обычные адреса принимаются — как и прежним паттерном', () => {
  for (const email of [
    'user@example.com',
    'u@b.c',
    'first.last+tag@sub.example.co.uk',
    "o'reilly@example.com",
    'a_b-c@xn--80ak6aa92e.xn--p1ai',
    'имя@пример.рф',
  ]) {
    assert.equal(isPlausibleEmail(email), true, email);
  }
});

test('мусор отвергается — включая пустые метки домена', () => {
  for (const email of [
    '',
    'plain',
    '@example.com',
    'user@',
    'user@example',
    'user@@example.com',
    'a@b@c.d',
    'us er@example.com',
    'user@exa mple.com',
    'user@example.com\n',
    // Строже прежнего ровно здесь: эти адреса старый паттерн пропускал, почта их не доставит.
    'user@.example.com',
    'user@example..com',
    'user@example.com.',
  ]) {
    assert.equal(isPlausibleEmail(email), false, JSON.stringify(email));
  }
});

test('не строка — не email (вызывающий не обязан приводить тип)', () => {
  for (const value of [undefined, null, 42, {}, ['a@b.c']]) {
    assert.equal(isPlausibleEmail(value), false, String(value));
  }
});

test('длина режется по RFC 5321: 254 символа — да, 255 — нет', () => {
  assert.equal(MAX_EMAIL_LENGTH, 254);
  const suffix = '@example.com';
  const longest = `${'a'.repeat(MAX_EMAIL_LENGTH - suffix.length)}${suffix}`;
  assert.equal(longest.length, 254);
  assert.equal(isPlausibleEmail(longest), true);
  assert.equal(isPlausibleEmail(`a${longest}`), false, 'по форме валиден, но длиннее предела');
});

test('патологические 100 КБ отвергаются быстро — и без предела длины разбор линеен', () => {
  // Паттерн проверяется и НАПРЯМУЮ, минуя предел длины: вторая защита обязана держать сама по себе.
  const bareRe = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
  const moduleSource = fs.readFileSync(require.resolve('../server/lib/emailAddress'), 'utf8');
  assert.ok(moduleSource.includes(`/${bareRe.source}/`), 'тест проверяет тот же паттерн, что живёт в модуле');
  for (const [name, input] of Object.entries(PATHOLOGICAL)) {
    assert.ok(input.length > 100_000, name);
    const guarded = timed(() => isPlausibleEmail(input));
    assert.equal(guarded.value, false, name);
    assert.ok(guarded.ms < BUDGET_MS, `${name}: isPlausibleEmail ${guarded.ms.toFixed(1)} мс`);
    const bare = timed(() => bareRe.test(input));
    assert.equal(bare.value, false, name);
    assert.ok(bare.ms < BUDGET_MS, `${name}: паттерн без предела длины ${bare.ms.toFixed(1)} мс`);
  }
});

// ── Публичные роуты auth ──────────────────────────────────────────────────────────────────────────
function authHarness() {
  const handlers = new Map();
  const app = {
    get: (p, ...h) => handlers.set(`GET ${p}`, h[h.length - 1]),
    post: (p, ...h) => handlers.set(`POST ${p}`, h[h.length - 1]),
    delete: (p, ...h) => handlers.set(`DELETE ${p}`, h[h.length - 1]),
  };
  const state = { lookups: [], created: [], emails: [], tails: [] };
  const db = {
    enabled: true,
    getUserByEmail: async (email) => {
      state.lookups.push(email);
      return email === 'known@example.com'
        ? { id: 1, email, status: 'unverified', pass_hash: 'x' }
        : null;
    },
    createUser: async ({ email, status }) => {
      state.created.push({ email, status });
      return { id: 2, email, status };
    },
    createEmailToken: async () => 1,
  };
  const jobTracker = {
    run: (task, { job }) => {
      const done = Promise.resolve().then(task);
      state.tails.push({ job, done });
      return done;
    },
  };
  const pass = (_req, _res, next) => next();
  registerAuthRoutes({
    app,
    express: { json: () => pass },
    db,
    requireAuth: pass,
    authLimiter: pass,
    asyncHandler: (fn) => fn,
    hashPassword: async (p) => `hash(${p})`,
    verifyPassword: async () => false,
    DUMMY_HASH: 'dummy',
    signSession: () => 'session',
    SESSION_TTL: 3600_000,
    SESSION_ABSOLUTE_TTL: 30 * 24 * 3600_000,
    GOOGLE_CLIENT_ID: null,
    fetchWithTimeout: async () => { throw new Error('не нужен'); },
    log: () => {},
    audit: async () => {},
    appBase: () => 'https://app.test',
    sha256: (v) => `sha(${v})`,
    newToken: () => 'raw-token',
    VERIFY_TTL: 24 * 3600_000,
    RESET_TTL: 3600_000,
    sendEmail: async (to, subject) => { state.emails.push({ to, subject }); return true; },
    emailShell: (title, body) => `${title}${body}`,
    emailBtn: (link, label) => `${label}:${link}`,
    escHtml: String,
    aiEnabledFor: () => false,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
    jobTracker,
  });

  /** Вызов обработчика с замером СИНХРОННОЙ части: именно она держала event loop. */
  async function call(route, body) {
    const handler = handlers.get(`POST ${route}`);
    assert.ok(handler, `${route} зарегистрирован`);
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    const req = { body, headers: {}, query: {}, get: () => undefined };
    const t0 = performance.now();
    const pending = handler(req, res, (e) => { if (e) throw e; });
    const syncMs = performance.now() - t0;
    await pending;
    await Promise.all(state.tails.map((t) => t.done));
    return { res, syncMs };
  }
  return { call, state };
}

test('register: 100 КБ-адрес — прежний 400 «Некорректный email», быстро и без БД', async () => {
  const { call, state } = authHarness();
  const { res, syncMs } = await call('/api/auth/register', { email: ATTACK, password: 'long enough pass' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Некорректный email' });
  assert.ok(syncMs < BUDGET_MS, `обработчик держал event loop ${syncMs.toFixed(1)} мс`);
  assert.deepEqual(state.lookups, []);
  assert.deepEqual(state.tails, []);
});

test('register: обычный мусор — тот же 400, обычный адрес — прежний generic-ответ и хвост', async () => {
  {
    const { call } = authHarness();
    const { res } = await call('/api/auth/register', { email: 'not-an-email', password: 'long enough pass' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Некорректный email' });
  }
  {
    const { call, state } = authHarness();
    const { res } = await call('/api/auth/register', { email: '  New@Example.com ', password: 'long enough pass' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'check_email');
    assert.deepEqual(state.tails.map((t) => t.job), ['auth_register_tail']);
    assert.deepEqual(state.created, [{ email: 'new@example.com', status: 'unverified' }]);
  }
});

test('forgot: 100 КБ-адрес — тот же generic 200, хвост не запускается, event loop свободен', async () => {
  const { call, state } = authHarness();
  const valid = await call('/api/auth/forgot', { email: 'someone@example.com' });
  const attack = await call('/api/auth/forgot', { email: ATTACK });
  assert.equal(attack.res.statusCode, 200);
  assert.deepEqual(attack.res.body, valid.res.body, 'ответ не отличим от ответа на обычный адрес');
  // Регулярка forgot стояла ПОСЛЕ res.json в том же тике: ответ уходил мгновенно, а процесс
  // замерзал. Поэтому меряем весь синхронный проход обработчика, а не время до ответа.
  assert.ok(attack.syncMs < BUDGET_MS, `обработчик держал event loop ${attack.syncMs.toFixed(1)} мс`);
  assert.deepEqual(state.lookups, ['someone@example.com'], 'в БД ушёл только обычный адрес');
  assert.deepEqual(state.tails.map((t) => t.job), ['auth_forgot_tail']);
});

test('resend-verification: мусорный адрес в БД не идёт, ответ прежний', async () => {
  const { call, state } = authHarness();
  const valid = await call('/api/auth/resend-verification', { email: 'known@example.com' });
  assert.equal(state.emails.length, 1, 'обычный путь по-прежнему шлёт письмо unverified-аккаунту');
  const attack = await call('/api/auth/resend-verification', { email: ATTACK });
  const junk = await call('/api/auth/resend-verification', { email: 'junk' });
  for (const r of [attack, junk]) {
    assert.equal(r.res.statusCode, 200);
    assert.deepEqual(r.res.body, valid.res.body);
    assert.ok(r.syncMs < BUDGET_MS, `обработчик держал event loop ${r.syncMs.toFixed(1)} мс`);
  }
  assert.deepEqual(state.lookups, ['known@example.com']);
  assert.deepEqual(state.tails.map((t) => t.job), ['auth_resend_tail']);
});
