'use strict';

// Integration-тесты mentionNotifyRepo — на РЕАЛЬНОМ Postgres. Без TEST_DATABASE_URL всё SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
// Проверяем: deep-link флоу (hash-токен, TTL, одноразовость), SQL-boundary подписки
// (член видит — пишет, посторонний — нет), runnable-JOIN (все четыре условия), watermark,
// filterNewMentions против архива mentions.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `mnot${Date.now().toString(36)}${process.pid}`;
const mail = (tag) => `${tag}.${nonce}@it.local`;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const S = {};

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });

  S.owner = await db.createUser({ email: mail('owner'), pass_hash: 'x', role: 'user', status: 'active' });
  S.stranger = await db.createUser({ email: mail('stranger'), pass_hash: 'x', role: 'user', status: 'active' });
  S.ch = await db.createTgChannel({
    owner_uid: S.owner.id, tg_channel_id: Date.now() % 2000000000, username: `mn_${nonce}`, title: 'Notify chan',
  });
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${nonce}%`]);
  await pool.query('DELETE FROM external_sources WHERE username LIKE $1', [`%${nonce}%`]);
  await pool.end();
  if (db) await db.close();
});

const asUser = (u) => ({ uid: u.id });

test('deep-link: issue → bind одноразов, повторный bind того же токена пуст', { skip }, async () => {
  const tokenHash = sha(`tok-${nonce}`);
  assert.ok(await db.issueMentionNotifyLink(S.owner.id, tokenHash, 15));

  const uid = await db.bindMentionNotifyByToken(tokenHash, { chat_id: 9001, tg_user_id: 42, username: 'tguser' });
  assert.strictEqual(uid, S.owner.id);
  const again = await db.bindMentionNotifyByToken(tokenHash, { chat_id: 9002 });
  assert.strictEqual(again, null, 'токен одноразовый — хеш очищен первым bind');

  const binding = await db.getMentionNotifyBinding(S.owner.id);
  assert.strictEqual(Number(binding.chat_id), 9001);
  assert.strictEqual(binding.username, 'tguser');
  assert.ok(binding.bound_at);
});

test('deep-link: просроченный токен не привязывает', { skip }, async () => {
  const tokenHash = sha(`expired-${nonce}`);
  await db.issueMentionNotifyLink(S.stranger.id, tokenHash, 15);
  await pool.query('UPDATE tg_notify_bindings SET link_expires_at = now() - interval \'1 minute\' WHERE uid=$1', [S.stranger.id]);
  assert.strictEqual(await db.bindMentionNotifyByToken(tokenHash, { chat_id: 9100 }), null);
});

test('подписка: владелец пишет, посторонний отвергается SQL-boundary', { skip }, async () => {
  const saved = await db.setMentionNotifySubscriptionForActor(S.ch.id, asUser(S.owner), true);
  assert.ok(saved, 'владелец канала может подписаться');
  assert.strictEqual(saved.enabled, true);
  assert.strictEqual(saved.last_notified_at, null);

  const denied = await db.setMentionNotifySubscriptionForActor(S.ch.id, asUser(S.stranger), true);
  assert.strictEqual(denied, null, 'посторонний не создаёт подписку даже мимо route-гейта');
  assert.strictEqual(await db.getMentionNotifySubscription(S.ch.id, S.stranger.id), null);
});

test('runnable-JOIN отдаёт подписку только при binding+rules+session и уважает reauth/unbind', { skip }, async () => {
  const mine = () => db.listRunnableMentionNotifySubscriptions()
    .then((rows) => rows.filter((r) => r.uid === S.owner.id && r.channel_id === S.ch.id));

  // Пока нет правил и сессии — не runnable (binding уже есть из первого теста).
  assert.strictEqual((await mine()).length, 0);

  await db.upsertMentionSettingsForActor(S.ch.id, asUser(S.owner), {
    include_terms: ['brand'], exclude_terms: [], exclude_sources: ['noise'], match_mode: 'word',
  });
  assert.strictEqual((await mine()).length, 0, 'правила есть, сессии нет');

  await db.saveTgSession(S.owner.id, { tg_user_id: 42, username: 'tguser', session_enc: 'enc-blob' });
  const rows = await mine();
  assert.strictEqual(rows.length, 1, 'все четыре условия закрыты');
  assert.strictEqual(Number(rows[0].chat_id), 9001);
  assert.deepStrictEqual(rows[0].include_terms, ['brand']);
  assert.strictEqual(rows[0].match_mode, 'word');
  assert.strictEqual(rows[0].session_enc, 'enc-blob');
  assert.strictEqual(rows[0].channel_username, `mn_${nonce}`);

  // reauth_required сессии выключает подписку из прогона.
  const { rows: [sess] } = await pool.query('SELECT session_version FROM tg_sessions WHERE uid=$1', [S.owner.id]);
  await db.recordTgSessionFailure(S.owner.id, sess.session_version, { state: 'reauth_required', errorCode: 'session_unauthorized' });
  assert.strictEqual((await mine()).length, 0);
  await db.recordTgSessionSuccess(S.owner.id, sess.session_version);
  assert.strictEqual((await mine()).length, 1);

  // Блокировка бота (unbind по chat_id) тоже.
  await db.unbindMentionNotifyChat(9001);
  assert.strictEqual((await mine()).length, 0);
});

test('markMentionNotifyRun двигает watermark только при notified=true', { skip }, async () => {
  await db.markMentionNotifyRun(S.ch.id, S.owner.id, { notified: false, errorCode: 'search_failed' });
  let sub = await db.getMentionNotifySubscription(S.ch.id, S.owner.id);
  assert.ok(sub.last_run_at);
  assert.strictEqual(sub.last_notified_at, null);
  assert.strictEqual(sub.last_error, 'search_failed');

  await db.markMentionNotifyRun(S.ch.id, S.owner.id, { notified: true, errorCode: null });
  sub = await db.getMentionNotifySubscription(S.ch.id, S.owner.id);
  assert.ok(sub.last_notified_at);
  assert.strictEqual(sub.last_error, null);
});

test('filterNewMentions вычитает уже-архивные пары против mentions', { skip }, async () => {
  const mention = (msgId) => ({
    channel_id: 424242, msg_id: msgId, date: '2026-07-22T10:00:00+00:00',
    title: 'Src', username: `src_${nonce}`, link: 'https://t.me/x/1', snippet: 's', views: 1, query: 'brand',
  });
  await db.upsertMentions(S.ch.id, [mention(1), mention(2)]);

  const fresh = await db.filterNewMentions(S.ch.id, [mention(1), mention(2), mention(3)]);
  assert.deepStrictEqual(fresh.map((m) => m.msg_id), [3]);
  assert.deepStrictEqual(await db.filterNewMentions(S.ch.id, [mention(1)]), []);
  assert.deepStrictEqual(await db.filterNewMentions(S.ch.id, []), []);
});
