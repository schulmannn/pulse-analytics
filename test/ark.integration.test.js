// Operation «Ковчег» — idempotency + data-invariant integration tests. Like tenancy.integration,
// these need a real Postgres and SKIP without TEST_DATABASE_URL (CI / `npm run check` stay DB-less):
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
//
// Each test uses run-nonce'd rows and cleans up after itself.
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `ark${Date.now().toString(36)}${process.pid}`;

test.before(() => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.PGSSL = process.env.PGSSL || 'disable';
  db = require('../server/db.js');
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE $1`, [`${nonce}%`]);
  await pool.end();
});

async function mkChannel(tag) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, pass_hash, role, status) VALUES ($1,'x','user','active') RETURNING id`,
    [`${tag}.${nonce}@it.local`]);
  const { rows: [c] } = await pool.query(
    `INSERT INTO channels (owner_uid, username, title, status, source) VALUES ($1,$2,$2,'active','collector') RETURNING id`,
    [u.id, `${tag}_${nonce}`]);
  return c.id;
}

test('persistCentralDaily: atomic + idempotent, no double-count on re-run', { skip }, async () => {
  const ch = await mkChannel('pcd');
  const day = '2026-07-06';
  const r1 = await db.persistCentralDaily(ch, {
    dailyRows: [{ day, subscribers: 1000, joins: 5, leaves: 1, views: 900, forwards: 3, reactions: 7 }],
    postRows: [{ post_id: 1, date_published: '2026-07-06T00:00:00Z', views: 900, reactions: 7, forwards: 3, replies: 0, erv: 1, virality: 0.3, media_type: 'photo', caption: 'x', hashtags: [] }],
    velocity: { available: true, by_day: [] },
  });
  assert.deepStrictEqual({ d: r1.channel_daily, p: r1.posts, v: r1.velocity }, { d: 1, p: 1, v: true });

  // Re-run the SAME day with a DIFFERENT subscriber value → overwrite, not append.
  await db.persistCentralDaily(ch, {
    dailyRows: [{ day, subscribers: 2000, joins: 6, leaves: 2, views: 950, forwards: 4, reactions: 8 }],
  });
  const { rows: [agg] } = await pool.query(
    `SELECT count(*)::int n, max(subscribers) subs FROM channel_daily WHERE channel_id=$1 AND day=$2`, [ch, day]);
  assert.strictEqual(agg.n, 1, 'ON CONFLICT overwrites — exactly one row per (channel, day)');
  assert.strictEqual(agg.subs, 2000, 'latest capture wins');
});

test('daily_ingest is idempotent per UTC date (double cron / second instance runs once)', { skip }, async () => {
  const key = `${nonce}:central:2026-07-06`;
  let runs = 0;
  const work = async () => { runs++; return { channel_daily: 42, posts: 7, velocity: true }; };
  const o1 = await db.runJobOnce('daily_ingest', key, work);
  const o2 = await db.runJobOnce('daily_ingest', key, work);
  assert.strictEqual(o1.skipped, false, 'first tick runs the heavy pass');
  assert.strictEqual(o2.skipped, true, 'duplicate tick skips it');
  assert.strictEqual(runs, 1, 'the MTProto pass executes exactly once');
  assert.deepStrictEqual(o2.job.result, { channel_daily: 42, posts: 7, velocity: true }, 'duplicate returns the cached result');
});

test('ingestCollectorPayload: same id+hash → cached duplicate; diff hash → INGEST_ID_CONFLICT', { skip }, async () => {
  const ch = await mkChannel('ing');
  const meta = { ingest_id: `${nonce}-ing-1`, schema_version: 1, collector_version: 't', collected_at: new Date().toISOString(), payload_hash: 'hashA' };
  const data = { snapshot: { channel: { id: 1 } }, dailyRows: [], postRows: [], mentions: [], velocity: null, tgChannelId: null };

  const first = await db.ingestCollectorPayload(ch, meta, data);
  assert.ok(first.ok && !first.duplicate, 'first delivery applied');

  const dup = await db.ingestCollectorPayload(ch, meta, data);   // same id + same hash
  assert.strictEqual(dup.duplicate, true, 'replay of the same payload returns the cached receipt');

  await assert.rejects(
    db.ingestCollectorPayload(ch, { ...meta, payload_hash: 'hashB' }, data),   // same id, different hash
    (e) => e.code === 'INGEST_ID_CONFLICT',
    'reusing an ingest_id with a different payload is rejected');
});

test('migrations are idempotent + forward-only (second run applies nothing)', { skip }, async () => {
  const { runMigrations } = require('../server/migrations.js');
  const before = (await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n;
  await runMigrations(pool, { log: () => {} });   // re-run — every file already in the ledger
  const after = (await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n;
  assert.strictEqual(after, before, 'no migration re-applies; the ledger is unchanged');
});
