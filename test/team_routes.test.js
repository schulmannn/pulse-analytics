'use strict';

// Route-тесты приглашений (H-1 из аудита #554). До этой правки маршрутов команды тестами накрыто
// не было вовсе — только репо.
//
// Атака, которую здесь пришпиливаем. Сырая ссылка приглашения возвращалась ИНИЦИАТОРУ, а публичный
// /claim по ней создавал сразу ACTIVE-аккаунт на чужой email с паролем открывшего ссылку и выдавал
// ему cookie на 30 дней. Владелец воркспейса мог так завести живой аккаунт на любой ящик.
//
// Инвариант: раскрытая ссылка (link_exposed) не активирует аккаунт. Он создаётся 'unverified', с
// НЕиспользуемым паролем (пароль открывшего ссылку не сохраняется), без cookie, и активируется
// только письмом на сам ящик. Нераскрытая ссылка сохраняет прежнее поведение.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { registerTeamRoutes } = require('../server/routes/team');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const RAW_TOKEN = 'raw-invite-token';

function harness(over = {}) {
  const handlers = new Map();
  const app = {
    get: (p, ...h) => handlers.set(`GET ${p}`, h[h.length - 1]),
    post: (p, ...h) => handlers.set(`POST ${p}`, h[h.length - 1]),
    patch: (p, ...h) => handlers.set(`PATCH ${p}`, h[h.length - 1]),
    delete: (p, ...h) => handlers.set(`DELETE ${p}`, h[h.length - 1]),
  };
  const state = {
    users: new Map(),          // email → строка
    nextUid: 100,
    emails: [],                // отправленные письма
    emailTokens: [],
    cookies: [],
    passwordWrites: [],
    statusWrites: [],
    accepted: [],
    invite: {
      status: 'live',
      email: 'victim@example.com',
      role: 'member',
      workspace_name: 'ws',
      invited_by_email: 'attacker@example.com',
      invitee_status: null,
      link_exposed: false,
      ...over.invite,
    },
  };
  if (over.existingUser) state.users.set(over.existingUser.email, over.existingUser);

  const db = {
    enabled: true,
    getWorkspaceInviteByToken: async (hash) => (hash === sha256(RAW_TOKEN) ? state.invite : null),
    getUserByEmail: async (email) => state.users.get(String(email).toLowerCase()) || null,
    getUserById: async (id) => [...state.users.values()].find((u) => u.id === id) || null,
    createUser: async ({ email, pass_hash, role, status, created_via }) => {
      const user = { id: state.nextUid++, email, pass_hash, role, status, created_via: created_via || null, token_version: 1 };
      state.users.set(email, user);
      return user;
    },
    setUserPassword: async (id, hash) => {
      state.passwordWrites.push({ id, hash });
      const u = [...state.users.values()].find((x) => x.id === id);
      if (u) { u.pass_hash = hash; u.token_version += 1; }
      return true;
    },
    setUserStatus: async (id, status) => {
      state.statusWrites.push({ id, status });
      const u = [...state.users.values()].find((x) => x.id === id);
      if (u) u.status = status;
      return u || null;
    },
    createEmailToken: async (uid, kind, hash, expiresAt) => {
      if (over.emailTokenCooldown) return null;
      state.emailTokens.push({ uid, kind, hash, expiresAt });
      return state.emailTokens.length;
    },
    acceptWorkspaceInvite: async ({ uid }) => {
      state.accepted.push(uid);
      return { outcome: 'accepted', workspace_id: 7, workspace_name: 'ws', role: state.invite.role };
    },
    markInviteLinkExposed: async () => true,
  };

  registerTeamRoutes({
    app,
    db,
    requireAuth: (_req, _res, next) => next(),
    authLimiter: (_req, _res, next) => next(),
    audit: async () => {},
    log: () => {},
    appBase: () => 'https://app.test',
    sha256,
    newToken: () => 'verify-raw-token',
    INVITE_TTL: 7 * 24 * 3600_000,
    VERIFY_TTL: 24 * 3600_000,
    sendEmail: async (to, subject, html) => { state.emails.push({ to, subject, html }); return true; },
    sendEmailDetailed: async () => ({ outcome: 'sent' }),
    emailConfigured: () => true,
    emailShell: (title, body) => `<html><h1>${title}</h1>${body}</html>`,
    emailBtn: (link, label) => `<a href="${link}">${label}</a>`,
    escHtml: (v) => String(v),
    hashPassword: async (p) => `hash(${p})`,
    signSession: () => 'session-token',
    SESSION_TTL: 3600_000,
    SESSION_ABSOLUTE_TTL: 30 * 24 * 3600_000,
    setSessionCookie: (_req, _res, token) => { state.cookies.push(token); },
  });
  return { handlers, state };
}

async function claim(handlers, { password = 'correct horse battery' } = {}) {
  const handler = handlers.get('POST /api/team/invite/:token/claim');
  assert.ok(handler, 'claim-роут зарегистрирован');
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ params: { token: RAW_TOKEN }, body: { password }, headers: {}, query: {} }, res, (e) => { if (e) throw e; });
  return res;
}

// ── Атака из отчёта ───────────────────────────────────────────────────────────────────────────────
test('раскрытая ссылка: аккаунт создаётся unverified, без cookie, с письмом подтверждения', async () => {
  const { handlers, state } = harness({ invite: { link_exposed: true } });
  const res = await claim(handlers);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verify_required, true);
  assert.deepEqual(state.cookies, [], 'сессия НЕ выдаётся — это и была суть захвата');
  const created = state.users.get('victim@example.com');
  assert.equal(created.status, 'unverified');
  assert.equal(created.created_via, 'invite_claim');
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].to, 'victim@example.com');
  assert.equal(state.emailTokens[0].kind, 'verify');
  assert.deepEqual(state.accepted, [created.id], 'приглашение гасится сразу — второй раз не сработает');
});

test('раскрытая ссылка: пароль открывшего НЕ сохраняется', async () => {
  const { handlers, state } = harness({ invite: { link_exposed: true } });
  await claim(handlers, { password: 'attacker-knows-this' });
  const created = state.users.get('victim@example.com');
  assert.equal(created.pass_hash.includes('attacker-knows-this'), false,
    'иначе подтверждение почты владельцем активировало бы аккаунт с паролем атакующего');
});

test('раскрытая ссылка + засеянный unverified: пароль гасится, а не сохраняется', async () => {
  // Прежняя версия проверки требовала ОБРАТНОГО — «пароль строки не перезаписывается» — и тем
  // закрепляла дыру: засеянный атакующим пароль переживал подтверждение почты владельцем, и
  // аккаунт активировался с ним (аудит #554, проход №2, N10). Ни выбранный сейчас пароль, ни
  // засеянный ранее не должны пережить этот путь.
  const existing = { id: 55, email: 'victim@example.com', pass_hash: 'hash(seeded-by-attacker)', role: 'user', status: 'unverified', token_version: 1 };
  const { handlers, state } = harness({ invite: { link_exposed: true, invitee_status: 'unverified' }, existingUser: existing });
  const res = await claim(handlers, { password: 'new-attacker-password' });

  assert.equal(res.body.verify_required, true);
  assert.equal(state.passwordWrites.length, 1, 'засеянный пароль обязан быть перезаписан');
  const written = state.passwordWrites[0];
  assert.equal(written.id, 55);
  assert.equal(written.hash.includes('new-attacker-password'), false, 'выбранный по раскрытой ссылке пароль не сохраняется');
  assert.equal(written.hash.includes('seeded-by-attacker'), false, 'и засеянный ранее — тоже');
  assert.deepEqual(state.statusWrites, [], 'аккаунт остаётся unverified: активирует только письмо');
  assert.deepEqual(state.cookies, []);
});

test('раскрытая ссылка: пароль не требуется — форма его и не спрашивает', async () => {
  const { handlers } = harness({ invite: { link_exposed: true } });
  const res = await claim(handlers, { password: '' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verify_required, true);
});

test('раскрытая ссылка: кулдаун письма не ломает ответ (о чужом ящике не рассказываем)', async () => {
  const { handlers, state } = harness({ invite: { link_exposed: true }, emailTokenCooldown: true });
  const res = await claim(handlers);
  assert.equal(res.body.verify_required, true);
  assert.deepEqual(state.emails, [], 'второе письмо в течение минуты не уходит');
});

// ── Нераскрытая ссылка: прежнее поведение ─────────────────────────────────────────────────────────
test('нераскрытая ссылка: аккаунт active, cookie выдаётся, письма нет', async () => {
  const { handlers, state } = harness();
  const res = await claim(handlers);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verify_required, undefined);
  assert.equal(state.cookies.length, 1, 'доставка письма доказала владение ящиком — вход сразу');
  const created = state.users.get('victim@example.com');
  assert.equal(created.status, 'active');
  assert.equal(created.pass_hash, 'hash(correct horse battery)');
  assert.deepEqual(state.emails, []);
});

test('нераскрытая ссылка: короткий пароль по-прежнему отвергается', async () => {
  const { handlers } = harness();
  const res = await claim(handlers, { password: 'short' });
  assert.equal(res.statusCode, 400);
});

test('нераскрытая ссылка + засеянный unverified: пароль перезаписывается, аккаунт активируется', async () => {
  const existing = { id: 55, email: 'victim@example.com', pass_hash: 'hash(seeded)', role: 'user', status: 'unverified', token_version: 1 };
  const { handlers, state } = harness({ invite: { invitee_status: 'unverified' }, existingUser: existing });
  await claim(handlers);
  assert.equal(state.passwordWrites.length, 1);
  assert.deepEqual(state.statusWrites, [{ id: 55, status: 'active' }]);
});

// ── Границы, не зависящие от раскрытия ────────────────────────────────────────────────────────────
test('живой active-аккаунт: 409 login_required в обеих ветках', async () => {
  for (const link_exposed of [false, true]) {
    const existing = { id: 9, email: 'victim@example.com', pass_hash: 'x', role: 'user', status: 'active', token_version: 1 };
    const { handlers, state } = harness({ invite: { link_exposed, invitee_status: 'active' }, existingUser: existing });
    const res = await claim(handlers);
    assert.equal(res.statusCode, 409, `link_exposed=${link_exposed}`);
    assert.equal(res.body.code, 'login_required');
    assert.deepEqual(state.cookies, []);
  }
});

test('мёртвая ссылка не заводит аккаунт', async () => {
  for (const status of ['revoked', 'expired', 'accepted']) {
    const { handlers, state } = harness({ invite: { status, link_exposed: true } });
    const res = await claim(handlers);
    assert.equal(res.statusCode, 400, status);
    assert.equal(state.users.size, 0);
    assert.deepEqual(state.emails, []);
  }
});

// ── Превью ────────────────────────────────────────────────────────────────────────────────────────
test('превью сообщает verify_required, чтобы страница не просила пароль зря', async () => {
  const { handlers } = harness({ invite: { link_exposed: true } });
  const handler = handlers.get('GET /api/team/invite/:token');
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params: { token: RAW_TOKEN }, headers: {}, query: {} }, res, (e) => { if (e) throw e; });
  assert.equal(res.body.verify_required, true);
  assert.equal(res.body.needs_account, true);
});
