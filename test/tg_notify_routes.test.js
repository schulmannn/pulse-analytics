'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { registerTgNotifyRoutes } = require('../server/routes/tgNotify');
const { webhookSecretOf } = require('../server/lib/tgNotifyText');

const SECRET = webhookSecretOf('bot:token');
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function createRoutes(overrides = {}) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
    put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); },
    delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); },
  };
  const calls = { audit: [], logs: [], sent: [], unbound: [], links: [], subs: [] };
  const db = {
    enabled: true,
    isDbUnavailable: () => false,
    issueMentionNotifyLink: async (uid, tokenHash, ttl) => { calls.links.push({ uid, tokenHash, ttl }); return true; },
    bindMentionNotifyByToken: async (tokenHash) => (tokenHash === sha256('validtoken123') ? 42 : null),
    getMentionNotifyBinding: async () => ({ uid: 11, chat_id: 555, username: 'user', bound_at: '2026-07-22T10:00:00+00:00' }),
    deleteMentionNotifyBinding: async () => true,
    unbindMentionNotifyChat: async (chatId) => { calls.unbound.push(chatId); return true; },
    getMentionNotifySubscription: async () => ({ enabled: false, last_run_at: null, last_notified_at: null, last_error: null }),
    setMentionNotifySubscriptionForActor: async (channelId, actor, enabled) => {
      calls.subs.push({ channelId, uid: actor.uid, enabled });
      return { channel_id: channelId, uid: actor.uid, enabled, last_run_at: null, last_notified_at: null, last_error: null };
    },
    getMentionSettingsForActor: async () => ({ configured: true }),
    getTgSession: async () => ({ uid: 11, session_enc: 'enc', connection_state: 'healthy' }),
    ...overrides.db,
  };
  const tgBot = {
    configured: () => true,
    getUsername: async () => 'atlavue_bot',
    ensureWebhook: async () => true,
    sendMessage: async (chatId, text) => { calls.sent.push({ chatId, text }); return { ok: true }; },
    ...overrides.tgBot,
  };
  registerTgNotifyRoutes({
    app,
    requireAuth: (_req, _res, next) => next(),
    resolveChannel: (_req, _res, next) => next(),
    db,
    audit: async (_req, action, metadata) => { calls.audit.push({ action, metadata }); },
    log: (level, event, metadata) => calls.logs.push({ level, event, metadata }),
    tgBot,
    webhookSecret: SECRET,
    newToken: () => 'validtoken123',
    sha256,
    appBase: () => 'https://atlavue.app',
  });
  return { routes, db, calls };
}

async function invoke(handlers, req = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(body) { this.body = body; return this; },
  };
  let nextError = null;
  const request = {
    body: {},
    headers: {},
    user: { uid: 11 },
    channel: { id: 7, owner_uid: 11, member_role: 'owner', username: 'own_brand', tg_channel_id: '777' },
    ...req,
  };
  await handlers.at(-1)(request, res, (error) => { nextError = error; });
  if (nextError) throw nextError;
  return res;
}

// ── Вебхук ─────────────────────────────────────────────────────────────────────────────────────────

test('webhook rejects a missing or wrong secret without leaking details', async () => {
  const { routes } = createRoutes();
  const noSecret = await invoke(routes.get('POST /api/tg-bot/webhook'), { headers: {} });
  assert.equal(noSecret.statusCode, 403);
  const wrong = await invoke(routes.get('POST /api/tg-bot/webhook'), {
    headers: { 'x-telegram-bot-api-secret-token': 'guess' },
  });
  assert.equal(wrong.statusCode, 403);
});

test('webhook /start with a valid token binds and replies in chat', async () => {
  const { routes, calls } = createRoutes();
  const res = await invoke(routes.get('POST /api/tg-bot/webhook'), {
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body: {
      message: {
        text: '/start validtoken123',
        chat: { id: 555, type: 'private' },
        from: { id: 999, username: 'user' },
      },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // Ответ в чат подтверждает привязку (best-effort, но в happy-path обязан отправиться).
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /Готово/);
});

test('webhook /start with a stale token still answers 200 but reports expiry to the chat', async () => {
  const { routes, calls } = createRoutes();
  const res = await invoke(routes.get('POST /api/tg-bot/webhook'), {
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body: {
      message: { text: '/start expiredtoken1', chat: { id: 556, type: 'private' }, from: {} },
    },
  });
  assert.equal(res.statusCode, 200);
  assert.match(calls.sent[0].text, /устарела/);
});

test('webhook ignores group /start and non-start chatter', async () => {
  const { routes, calls } = createRoutes();
  await invoke(routes.get('POST /api/tg-bot/webhook'), {
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body: { message: { text: '/start validtoken123', chat: { id: -100, type: 'supergroup' }, from: {} } },
  });
  await invoke(routes.get('POST /api/tg-bot/webhook'), {
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body: { message: { text: 'привет', chat: { id: 555, type: 'private' }, from: {} } },
  });
  assert.equal(calls.sent.length, 0);
});

test('webhook my_chat_member kicked unbinds the chat', async () => {
  const { routes, calls } = createRoutes();
  const res = await invoke(routes.get('POST /api/tg-bot/webhook'), {
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body: { my_chat_member: { chat: { id: 555 }, new_chat_member: { status: 'kicked' } } },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.unbound, [555]);
});

test('webhook answers 503 on transient DB unavailability so Telegram retries', async () => {
  const { routes } = createRoutes({
    db: {
      isDbUnavailable: () => true,
      bindMentionNotifyByToken: async () => { throw new Error('db down'); },
    },
  });
  const res = await invoke(routes.get('POST /api/tg-bot/webhook'), {
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    body: { message: { text: '/start validtoken123', chat: { id: 555, type: 'private' }, from: {} } },
  });
  assert.equal(res.statusCode, 503);
});

// ── Deep-link ──────────────────────────────────────────────────────────────────────────────────────

test('link endpoint stores only the token hash and returns the t.me URL', async () => {
  const { routes, calls } = createRoutes();
  const res = await invoke(routes.get('POST /api/tg/mention-notify/link'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, 'https://t.me/atlavue_bot?start=validtoken123');
  assert.equal(calls.links[0].uid, 11);
  assert.equal(calls.links[0].tokenHash, sha256('validtoken123'));   // в БД — хеш, не токен
  assert.equal(calls.audit[0].action, 'tg.mention_notify.link_issued');
});

test('link endpoint fails closed when webhook registration fails', async () => {
  const { routes } = createRoutes({ tgBot: { ensureWebhook: async () => { throw new Error('net'); } } });
  const res = await invoke(routes.get('POST /api/tg/mention-notify/link'));
  assert.equal(res.statusCode, 503);
});

// ── Статус и тумблер ───────────────────────────────────────────────────────────────────────────────

test('GET status aggregates binding, subscription and requirements', async () => {
  const { routes } = createRoutes();
  const res = await invoke(routes.get('GET /api/tg/mention-notify'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.binding.bound, true);
  assert.equal(res.body.subscription.enabled, false);
  assert.deepEqual(res.body.requirements, { rules_configured: true, session_state: 'ok' });
});

test('PUT enable requires binding, rules and a live session (409 with reason)', async () => {
  const noBinding = createRoutes({ db: { getMentionNotifyBinding: async () => null } });
  let res = await invoke(noBinding.routes.get('PUT /api/tg/mention-notify'), { body: { enabled: true } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'no_binding');

  const noRules = createRoutes({ db: { getMentionSettingsForActor: async () => ({ configured: false }) } });
  res = await invoke(noRules.routes.get('PUT /api/tg/mention-notify'), { body: { enabled: true } });
  assert.equal(res.body.reason, 'no_rules');

  const reauth = createRoutes({ db: { getTgSession: async () => ({ session_enc: 'enc', connection_state: 'reauth_required' }) } });
  res = await invoke(reauth.routes.get('PUT /api/tg/mention-notify'), { body: { enabled: true } });
  assert.equal(res.body.reason, 'reauth_required');
});

test('PUT enable happy-path writes through the actor gate and audits', async () => {
  const { routes, calls } = createRoutes();
  const res = await invoke(routes.get('PUT /api/tg/mention-notify'), { body: { enabled: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
  assert.deepEqual(calls.subs, [{ channelId: 7, uid: 11, enabled: true }]);
  assert.equal(calls.audit[0].action, 'tg.mention_notify.enabled');
});

test('PUT disable skips requirement checks and always lands', async () => {
  const { routes } = createRoutes({
    db: {
      getMentionNotifyBinding: async () => null,
      getMentionSettingsForActor: async () => ({ configured: false }),
      getTgSession: async () => null,
    },
  });
  const res = await invoke(routes.get('PUT /api/tg/mention-notify'), { body: { enabled: false } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, false);
});

test('PUT answers 403 when the SQL boundary rejects the actor', async () => {
  const { routes } = createRoutes({ db: { setMentionNotifySubscriptionForActor: async () => null } });
  const res = await invoke(routes.get('PUT /api/tg/mention-notify'), { body: { enabled: false } });
  assert.equal(res.statusCode, 403);
});

test('DELETE binding unbinds and audits', async () => {
  const { routes, calls } = createRoutes();
  const res = await invoke(routes.get('DELETE /api/tg/mention-notify/binding'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.audit[0].action, 'tg.mention_notify.unbound');
});
