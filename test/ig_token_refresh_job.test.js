'use strict';

// Юнит-тесты проактивного продления токенов Instagram (jobs/igTokenRefreshJob).
// Фейковые часы + фейковый refreshIgIfNeeded → детерминизм без сети и без БД. Проверяем: в работу
// берутся ТОЛЬКО аккаунты внутри окна продления (истёкшие и далёкие пропускаются), счётчики
// сходятся, ошибка одного аккаунта изолирована, а без БД или ключа шифрования полоса инертна.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIgTokenRefreshJob } = require('../server/jobs/igTokenRefreshJob');
const { igTokenState, igTokenDueForRefresh } = require('../server/domain/igToken');

const NOW = Date.parse('2026-09-03T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(NOW + n * DAY).toISOString();

function makeJob({ accounts = [], refresh, igConfigured = true, dbEnabled = true, listThrows = false } = {}) {
  const events = [];
  const refreshed = [];
  const job = createIgTokenRefreshJob({
    db: {
      enabled: dbEnabled,
      listIgAccounts: async () => { if (listThrows) throw new Error('pool down'); return accounts; },
    },
    log: (level, event, meta) => events.push({ level, event, meta }),
    igCrypto: { configured: () => igConfigured, decrypt: (enc) => String(enc).replace(/^enc\((.*)\)$/, '$1') },
    refreshIgIfNeeded: refresh || (async (channelId, token) => { refreshed.push(channelId); return `${token}_NEW`; }),
    clock: () => NOW,
  });
  return { job, events, refreshed };
}

const acc = (channelId, expiresInDays) => ({
  channel_id: channelId,
  ig_user_id: `ig-${channelId}`,
  access_token_enc: `enc(TOKEN_${channelId})`,
  token_expires_at: inDays(expiresInDays),
});

// ── Домен окна ────────────────────────────────────────────────────────────────────────────────────
test('igTokenState: четыре состояния по одному правилу', () => {
  assert.equal(igTokenState(null, NOW), 'none');
  assert.equal(igTokenState('не дата', NOW), 'none');
  assert.equal(igTokenState(inDays(-1), NOW), 'expired');
  assert.equal(igTokenState(inDays(3), NOW), 'expiring');
  assert.equal(igTokenState(inDays(30), NOW), 'ok');
  // Ровно на границе окна — уже пора продлевать: край не должен проваливаться в «ok».
  assert.equal(igTokenState(new Date(NOW + 10 * DAY).toISOString(), NOW), 'expiring');
  assert.equal(igTokenDueForRefresh(inDays(-1), NOW), false);   // истёкший продлить нельзя
  assert.equal(igTokenDueForRefresh(inDays(3), NOW), true);
});

// ── Отбор аккаунтов ───────────────────────────────────────────────────────────────────────────────
test('в работу идут только аккаунты внутри окна продления', async () => {
  const { job, refreshed } = makeJob({
    accounts: [acc(1, 3), acc(2, 30), acc(3, -1), acc(4, 9)],
  });
  const stats = await job.processIgTokenRefresh();
  assert.deepEqual(stats, { due: 2, refreshed: 2, rejected: 0 });
  assert.deepEqual(refreshed.sort(), [1, 4]);   // 30 дней рано, истёкший уже не спасти
});

test('аккаунт без токена в строке пропускается', async () => {
  const { job } = makeJob({ accounts: [{ channel_id: 7, token_expires_at: inDays(2), access_token_enc: null }] });
  assert.deepEqual(await job.processIgTokenRefresh(), { due: 0, refreshed: 0, rejected: 0 });
});

// ── Счётчики и лог ────────────────────────────────────────────────────────────────────────────────
test('отказ Graph считается rejected: refreshIgIfNeeded вернул ТОТ ЖЕ токен', async () => {
  const { job, events } = makeJob({
    accounts: [acc(1, 2), acc(2, 2)],
    refresh: async (channelId, token) => (channelId === 1 ? `${token}_NEW` : token),
  });
  const stats = await job.processIgTokenRefresh();
  assert.deepEqual(stats, { due: 2, refreshed: 1, rejected: 1 });
  const pass = events.find((e) => e.event === 'ig_token_refresh_pass');
  assert.deepEqual(pass.meta, { due: 2, refreshed: 1, rejected: 1 });
});

test('падение одного аккаунта изолировано: соседний всё равно продлевается', async () => {
  const { job, events } = makeJob({
    accounts: [acc(1, 2), acc(2, 2)],
    refresh: async (channelId, token) => { if (channelId === 1) throw new Error('boom'); return `${token}_NEW`; },
  });
  const stats = await job.processIgTokenRefresh();
  assert.deepEqual(stats, { due: 2, refreshed: 1, rejected: 1 });
  const failed = events.find((e) => e.event === 'ig_token_refresh_account_failed');
  assert.equal(failed.meta.channelId, 1);
});

test('без due-аккаунтов проход молчит: пустой пасс не засоряет лог', async () => {
  const { job, events } = makeJob({ accounts: [acc(1, 30)] });
  assert.deepEqual(await job.processIgTokenRefresh(), { due: 0, refreshed: 0, rejected: 0 });
  assert.equal(events.length, 0);
});

// ── Инертность ────────────────────────────────────────────────────────────────────────────────────
test('без БД и без ключа шифрования полоса инертна', async () => {
  const off = makeJob({ accounts: [acc(1, 2)], dbEnabled: false });
  assert.deepEqual(await off.job.processIgTokenRefresh(), { due: 0, refreshed: 0, rejected: 0 });
  const noKey = makeJob({ accounts: [acc(1, 2)], igConfigured: false });
  assert.deepEqual(await noKey.job.processIgTokenRefresh(), { due: 0, refreshed: 0, rejected: 0 });
});

test('падение listIgAccounts не роняет проход', async () => {
  const { job, events } = makeJob({ listThrows: true });
  assert.deepEqual(await job.processIgTokenRefresh(), { due: 0, refreshed: 0, rejected: 0 });
  assert.equal(events.find((e) => e.event === 'ig_list_accounts_failed').level, 'error');
});
