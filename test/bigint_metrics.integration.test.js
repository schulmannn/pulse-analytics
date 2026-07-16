'use strict';

// Integration tests for the BIGINT metric-counter release (migration 023) on a REAL Postgres.
// Proves end-to-end that:
//   • Telegram + Instagram writers round-trip values above INT4 (3e9) — the migration is applied and
//     jsonb_to_recordset declarations are bigint, so no overflow / no clamp;
//   • API-facing repository reads return JS numbers for counters, while BIGINT identifiers keep their
//     existing string contract (post_id, mention channel_id);
//   • a stored BIGINT beyond MAX_SAFE_METRIC reads back as null (honest missing), never a lossy or
//     saturated number;
//   • legitimate zero is preserved (distinct from null / missing).
// Without TEST_DATABASE_URL the whole suite SKIPs, like the other integration suites.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');
const { MAX_SAFE_METRIC } = require('../server/lib/metricNumber');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

const INT4_MAX = 2_147_483_647;
const BIG = 3_000_000_000; // > INT4_MAX, exact safe JS integer

let db = null;
let pool = null;
const nonce = `big${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = (tag) => `${tag}.${seq++}.${nonce}@it.local`;
const today = new Date().toISOString().slice(0, 10);

const mkUser = (tag) => db.createUser({ email: mail(tag), pass_hash: 'x', role: 'user', status: 'active' });
const mkChannel = async (tag) => {
  const u = await mkUser(tag);
  const ch = await db.createChannel({ owner_uid: u.id, username: `c.${tag}.${nonce}` });
  return { u, ch };
};

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM ig_tags WHERE media_id LIKE $1`, [`%${nonce}%`]);
  await pool.query(
    `DELETE FROM mentions WHERE owner_channel_id IN (SELECT id FROM channels WHERE owner_uid IN (SELECT id FROM users WHERE email LIKE $1))`,
    [`%${nonce}%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.end();
});

test('sanity: BIG is genuinely beyond the old INT4 ceiling', { skip }, () => {
  assert.ok(BIG > INT4_MAX);
});

test('Telegram writers round-trip >INT4; reads return numbers, ids stay strings, zero preserved', { skip }, async () => {
  const { u, ch } = await mkChannel('tg');

  await db.upsertChannelDaily(ch.id, [{
    day: today, subscribers: BIG, joins: BIG + 1, leaves: 0, views: BIG + 2, forwards: 3, reactions: BIG + 4,
  }]);
  const postId = 5_000_000_001; // large Telegram message id (BIGINT identifier)
  await db.upsertPosts(ch.id, [{
    post_id: postId, date_published: new Date().toISOString(),
    views: BIG, reactions: BIG + 1, forwards: 2, replies: 0,
    erv: 1.5, virality: null, media_type: 'text', caption: 'x', hashtags: [],
  }]);
  await db.upsertMentions(ch.id, [{
    channel_id: 777, msg_id: 42, date: new Date().toISOString(),
    title: 't', username: 'u', link: 'l', snippet: 's', views: BIG, query: 'q',
  }]);

  // channel_daily read
  const hist = await db.getChannelHistoryInternal(ch.id, 30);
  const row = hist.find((r) => r.day === today);
  assert.ok(row, 'daily row present');
  assert.strictEqual(row.subscribers, BIG);
  assert.strictEqual(typeof row.subscribers, 'number');
  assert.strictEqual(row.joins, BIG + 1);
  assert.strictEqual(row.views, BIG + 2);
  assert.strictEqual(row.reactions, BIG + 4);
  assert.strictEqual(row.leaves, 0, 'legitimate zero preserved');

  // memberCount (listChannels) surfaces subscribers as a JS number
  const channels = await db.listChannels({ uid: u.id });
  const listed = channels.find((c) => c.id === ch.id);
  assert.ok(listed, 'channel listed');
  assert.strictEqual(listed.memberCount, BIG);
  assert.strictEqual(typeof listed.memberCount, 'number');

  // posts read: counters numeric, post_id identifier remains a string
  const posts = await db.listPostsInternal(ch.id, 10);
  const p = posts.find((x) => String(x.id) === String(postId));
  assert.ok(p, 'post present');
  assert.strictEqual(p.views, BIG);
  assert.strictEqual(typeof p.views, 'number');
  assert.strictEqual(p.replies, 0, 'zero preserved');
  assert.strictEqual(typeof p.id, 'string', 'BIGINT post id stays a string');
  assert.strictEqual(p.id, String(postId));

  // mentions read: views numeric, mentioning channel_id (BIGINT peer id) stays a string
  const mentions = await db.getMentionsArchiveInternal(ch.id, { days: 0, limit: 10 });
  const m = mentions.recent.find((x) => String(x.views) === String(BIG));
  assert.ok(m, 'mention present');
  assert.strictEqual(m.views, BIG);
  assert.strictEqual(typeof m.views, 'number');
  assert.strictEqual(typeof m.channel_id, 'string', 'BIGINT mention channel_id stays a string');
});

test('Instagram writers round-trip >INT4; ig reads return JS numbers, zero preserved', { skip }, async () => {
  const { ch } = await mkChannel('ig');

  await db.upsertIgDaily(ch.id, [{
    day: today, followers: BIG, followers_total: BIG + 10, reach: BIG, views: BIG, profile_views: 0,
    accounts_engaged: 1, total_interactions: BIG, likes: BIG, comments: 2, saves: 3, shares: 4, follows: 5, unfollows: 0,
  }]);
  const mediaId = `m.${nonce}`;
  await db.upsertIgMediaDaily(ch.id, [{
    media_id: mediaId, day: today, reach: BIG, likes: BIG, comments: 1, saved: 2, shares: 3, views: BIG,
  }]);

  const igd = await db.listIgDailyInternal(ch.id, 30);
  const r = igd.find((x) => x.day === today);
  assert.ok(r, 'ig_daily row present');
  assert.strictEqual(r.followers, BIG);
  assert.strictEqual(r.followers_total, BIG + 10);
  assert.strictEqual(r.total_interactions, BIG);
  assert.strictEqual(typeof r.reach, 'number');
  assert.strictEqual(r.profile_views, 0, 'zero preserved');
  assert.strictEqual(r.unfollows, 0, 'zero preserved');

  const media = await db.listIgMediaDailyInternal(ch.id, 30);
  const mm = media.find((x) => x.media_id === mediaId);
  assert.ok(mm, 'ig_media_daily row present');
  assert.strictEqual(mm.reach, BIG);
  assert.strictEqual(mm.views, BIG);
  assert.strictEqual(typeof mm.views, 'number');
  assert.strictEqual(mm.comments, 1);
  assert.strictEqual(typeof mm.media_id, 'string', 'media_id stays a TEXT identifier');

  const taggedId = `tag.${nonce}`;
  await db.upsertIgTags(ch.id, [{
    id: taggedId, username: 'fan', caption: 'tagged', like_count: BIG, comments_count: BIG + 1,
    timestamp: new Date().toISOString(),
  }]);
  const tag = (await db.listIgTagsInternal(ch.id, 500)).find((x) => x.id === taggedId);
  assert.ok(tag, 'ig_tags row present');
  assert.strictEqual(tag.like_count, BIG);
  assert.strictEqual(tag.comments_count, BIG + 1);
  assert.strictEqual(typeof tag.like_count, 'number');
});

test('monthly rollup accepts a >INT4 subscriber level from widened channel_daily', { skip }, async () => {
  const { ch } = await mkChannel('rollup');
  await db.upsertChannelDaily(ch.id, [{
    day: today, subscribers: BIG, joins: 1, leaves: 0, views: 2, forwards: 0, reactions: 0,
  }]);
  await db.rollupChannelMonthly(3);
  const { rows } = await pool.query(
    `SELECT subscribers_end FROM channel_monthly WHERE channel_id=$1 ORDER BY month DESC LIMIT 1`,
    [ch.id]);
  assert.strictEqual(rows[0]?.subscribers_end, String(BIG));
});

test('normal (small) values are unchanged by the widening', { skip }, async () => {
  const { ch } = await mkChannel('norm');
  await db.upsertChannelDaily(ch.id, [{
    day: today, subscribers: 100, joins: 5, leaves: 1, views: 200, forwards: 3, reactions: 7,
  }]);
  const hist = await db.getChannelHistoryInternal(ch.id, 30);
  const row = hist.find((r) => r.day === today);
  assert.strictEqual(row.subscribers, 100);
  assert.strictEqual(row.views, 200);
  assert.strictEqual(row.forwards, 3);
});

test('a stored BIGINT beyond MAX_SAFE_METRIC reads back as null, never a lossy/saturated number', { skip }, async () => {
  const { ch } = await mkChannel('over');
  // Simulate a counter that slipped past (or predates) the write guard: a valid PostgreSQL BIGINT
  // beyond Number.MAX_SAFE_INTEGER. The read must honestly report missing, not a rounded number.
  const OVER = '9007199254740992';
  await pool.query(
    `INSERT INTO channel_daily (channel_id, source_id, day, subscribers, views, captured_at)
       SELECT $1, (SELECT c.source_id FROM channels c WHERE c.id = $1), $2::date, $3::bigint, 100, now()`,
    [ch.id, today, OVER]);
  const hist = await db.getChannelHistoryInternal(ch.id, 30);
  const row = hist.find((r) => r.day === today);
  assert.ok(row, 'daily row present');
  assert.strictEqual(row.subscribers, null, 'out-of-bound counter is honest null, not lossy/saturated');
  assert.strictEqual(row.views, 100, 'the safe sibling counter is unaffected');
});
