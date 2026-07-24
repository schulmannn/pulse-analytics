'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMentionNotifyJob } = require('../server/jobs/mentionNotifyJob');

const SUB = {
  channel_id: 7,
  uid: 11,
  last_notified_at: '2026-07-20T06:00:00+00:00',
  chat_id: 555,
  channel_title: 'Мой бренд',
  channel_username: 'own_brand',
  tg_channel_id: '777',
  include_terms: ['brand'],
  exclude_terms: [],
  exclude_sources: ['noise'],
  match_mode: 'contains',
  session_enc: 'enc',
  session_version: '3',
  connection_state: 'healthy',
};

const MENTION = (id, extra = {}) => ({
  channel_id: 100, msg_id: id, title: 'Чужой канал', username: 'other',
  link: `https://t.me/other/${id}`, snippet: `упоминание ${id}`, date: `2026-07-22T0${id % 10}:00:00+00:00`,
  views: 10, query: 'brand', ...extra,
});

function makeJob({ subs = [SUB], searchResult, searchError, fresh, sendResults, health = [] } = {}) {
  const calls = { search: [], sent: [], upserted: [], marked: [], unbound: [], logs: [], health };
  const db = {
    enabled: true,
    listRunnableMentionNotifySubscriptions: async () => subs,
    runJobOnce: async (_kind, _key, fn) => ({ skipped: false, result: await fn() }),
    filterNewMentions: async (_channelId, list) => (fresh !== undefined ? fresh : list),
    upsertMentions: async (channelId, list) => { calls.upserted.push({ channelId, count: list.length }); return list.length; },
    markMentionNotifyRun: async (channelId, uid, arg) => { calls.marked.push({ channelId, uid, ...arg }); return true; },
    unbindMentionNotifyChat: async (chatId) => { calls.unbound.push(chatId); return true; },
    recordTgSessionSuccess: async (uid) => { health.push(['success', uid]); return true; },
    recordTgSessionFailure: async (uid, _v, arg) => { health.push(['failure', uid, arg]); return true; },
    rotateTgSessionCiphertext: async () => true,
  };
  const tgBot = {
    configured: () => true,
    sendMessage: async (chatId, text) => {
      calls.sent.push({ chatId, text });
      if (sendResults && sendResults.length) return sendResults.shift();
      return { ok: true };
    },
  };
  const job = createMentionNotifyJob({
    db,
    log: (level, event, metadata) => calls.logs.push({ level, event, metadata }),
    tgCrypto: {
      configured: () => true,
      encrypt: (v) => `enc:${v}`,
      decryptDetailed: () => ({ plaintext: 'plain-session', usedPreviousKey: false }),
    },
    tgBot,
    mtprotoPost: async (path, opts) => {
      calls.search.push({ path, body: opts.body });
      if (searchError) throw searchError;
      return searchResult !== undefined ? searchResult : { available: true, all: [] };
    },
    MTPROTO_TOKEN: 'internal',
    MTPROTO_TIMEOUT_HEAVY_MS: 120000,
    appUrl: 'https://atlavue.app',
  });
  return { job, calls };
}

test('a regular run sends cards only for fresh mentions, oldest first, then persists the archive', async () => {
  const all = [MENTION(1), MENTION(2), MENTION(3)];
  const { job, calls } = makeJob({ searchResult: { available: true, all }, fresh: [MENTION(3), MENTION(2)] });
  await job.processMentionNotify();

  // Поиск шёл через сессию подписчика с его правилами и авто-исключением собственного канала.
  assert.equal(calls.search[0].path, '/mentions/search');
  assert.equal(calls.search[0].body.session, 'plain-session');
  assert.deepEqual(calls.search[0].body.exclude_sources, ['noise', 'own_brand']);
  assert.deepEqual(calls.search[0].body.exclude_channel_ids, [777]);

  assert.equal(calls.sent.length, 2);
  assert.match(calls.sent[0].text, /упоминание 2/);   // старые раньше
  assert.match(calls.sent[1].text, /упоминание 3/);
  assert.deepEqual(calls.upserted, [{ channelId: 7, count: 3 }]);
  assert.deepEqual(calls.marked, [{ channelId: 7, uid: 11, notified: true, errorCode: null }]);
  assert.deepEqual(calls.health.at(-1), ['success', 11]);
});

test('the first run seeds with one summary instead of dumping the archive', async () => {
  const all = Array.from({ length: 20 }, (_, i) => MENTION(i + 1));
  const { job, calls } = makeJob({
    subs: [{ ...SUB, last_notified_at: null }],
    searchResult: { available: true, all },
  });
  await job.processMentionNotify();
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /Уведомления об упоминаниях включены/);
  assert.match(calls.sent[0].text, /20 упоминаний/);
  assert.deepEqual(calls.upserted, [{ channelId: 7, count: 20 }]);
});

test('card overflow collapses the tail into one summary message', async () => {
  const fresh = Array.from({ length: 11 }, (_, i) => MENTION(i + 1));
  const { job, calls } = makeJob({ searchResult: { available: true, all: fresh }, fresh });
  await job.processMentionNotify();
  assert.equal(calls.sent.length, 9);                     // 8 карточек + 1 сводка
  assert.match(calls.sent.at(-1).text, /ещё 3 новых/);
  assert.match(calls.sent.at(-1).text, /atlavue\.app\/mentions/);
});

test('a 401 from mtproto marks reauth_required and skips the archive write', async () => {
  const err = Object.assign(new Error('unauthorized'), { status: 401 });
  const { job, calls } = makeJob({ searchError: err });
  await job.processMentionNotify();
  assert.equal(calls.upserted.length, 0);
  assert.deepEqual(calls.marked, [{ channelId: 7, uid: 11, notified: false, errorCode: 'reauth_required' }]);
  assert.deepEqual(calls.health.at(-1), ['failure', 11, { state: 'reauth_required', errorCode: 'session_unauthorized' }]);
});

test('a blocked bot unbinds the chat and records bot_blocked without touching the archive', async () => {
  const { job, calls } = makeJob({
    searchResult: { available: true, all: [MENTION(1)] },
    sendResults: [{ ok: false, blocked: true }],
  });
  await job.processMentionNotify();
  assert.deepEqual(calls.unbound, [555]);
  assert.equal(calls.upserted.length, 0);                 // send-first: сбой доставки не двигает архив
  assert.equal(calls.marked[0].errorCode, 'bot_blocked');
});

test('an unavailable search result is a failure, not an empty success', async () => {
  const { job, calls } = makeJob({ searchResult: { available: false, error: 'нет квоты' } });
  await job.processMentionNotify();
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.marked[0].errorCode, 'search_failed');
});

test('the runner is inert without bot/crypto/token configuration', async () => {
  const { job, calls } = makeJob({});
  const bare = createMentionNotifyJob({
    db: { enabled: true },
    log: () => {},
    tgCrypto: { configured: () => false, decryptDetailed: () => ({}) },
    tgBot: { configured: () => true, sendMessage: async () => ({ ok: true }) },
    mtprotoPost: async () => { throw new Error('must not be called'); },
    MTPROTO_TOKEN: 'x',
    MTPROTO_TIMEOUT_HEAVY_MS: 1,
  });
  await bare.processMentionNotify();   // tgCrypto не настроен → тихий no-op
  await job.processMentionNotify();    // контрольный живой прогон
  assert.equal(calls.search.length, 1);
});
