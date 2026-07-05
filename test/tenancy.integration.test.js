// Integration tests for ADR-001 tenancy (workspace membership + canonical source reads) and the
// 012 jobs idempotency. They need a real Postgres with migrations applied — run them against the
// local stand:
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:54329/pulse npm test
//
// Without TEST_DATABASE_URL every test here SKIPS (CI and the default `npm run check` stay
// DB-less). Each run works on its own throwaway rows (emails/keys carry a run nonce) and cleans
// up after itself, so re-runs and parallel suites don't collide.
const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `t${Date.now().toString(36)}${process.pid}`;

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
  // Cascade wipes everything the run created (channels → daily/posts/… via FKs).
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE external_id LIKE $1`, [`${nonce}%`]);
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE $1`, [`${nonce}%`]);
  await pool.end();
});

async function mkUser(tag) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, pass_hash, role, status) VALUES ($1, 'x', 'user', 'active') RETURNING id`,
    [`${tag}.${nonce}@it.local`]);
  return u.id;
}

async function mkWorkspace(ownerUid, name) {
  const { rows: [w] } = await pool.query(
    `INSERT INTO workspaces (name, owner_uid) VALUES ($1, $2) RETURNING id`, [name, ownerUid]);
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
    [w.id, ownerUid]);
  return w.id;
}

async function mkSource(externalId) {
  const { rows: [s] } = await pool.query(
    `INSERT INTO external_sources (network, external_id) VALUES ('tg', $1)
     ON CONFLICT (network, external_id) DO UPDATE SET external_id = EXCLUDED.external_id
     RETURNING id`, [externalId]);
  return s.id;
}

async function mkChannel(ownerUid, workspaceId, sourceId, username) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO channels (owner_uid, workspace_id, source_id, username, title, status, source)
     VALUES ($1, $2, $3, $4, $4, 'active', 'collector') RETURNING id`,
    [ownerUid, workspaceId, sourceId, username]);
  return c.id;
}

test('workspace membership grants channel access; outsiders get null', { skip }, async () => {
  const owner = await mkUser('owner');
  const viewer = await mkUser('viewer');
  const outsider = await mkUser('outsider');
  const ws = await mkWorkspace(owner, `ws-${nonce}`);
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'viewer')`, [ws, viewer]);
  const src = await mkSource(`${nonce}-shared`);
  const ch = await mkChannel(owner, ws, src, `chan_${nonce}_a`);

  const asOwner = await db.getChannel(ch, { uid: owner });
  assert.ok(asOwner, 'creator sees the channel');
  assert.strictEqual(asOwner.member_role, 'owner');

  const asViewer = await db.getChannel(ch, { uid: viewer });
  assert.ok(asViewer, 'workspace member sees the channel');
  assert.strictEqual(asViewer.member_role, 'viewer');

  const asOutsider = await db.getChannel(ch, { uid: outsider });
  assert.strictEqual(asOutsider, null, 'non-member is denied');

  const ownerList = (await db.listChannels({ uid: viewer })).map((c) => c.id);
  assert.ok(ownerList.includes(ch), 'membership channel appears in listChannels');
});

test('cross-workspace users cannot read personal prefs or reports', { skip }, async () => {
  const alice = await mkUser('prefs-alice');
  const bob = await mkUser('prefs-bob');

  await db.setPrefs(alice, { homeBlocks: ['mine'], widgetConfigs: [{ id: 'w1' }] });
  assert.deepStrictEqual(await db.getPrefs(alice), { homeBlocks: ['mine'], widgetConfigs: [{ id: 'w1' }] });
  assert.strictEqual(await db.getPrefs(bob), null, 'prefs stay keyed to the session uid');

  const report = await db.createReport(alice, `tenant-report-${nonce}`, { blocks: ['overview'] });
  assert.ok(report && report.id, 'owner report created');
  assert.strictEqual(await db.getReport(bob, report.id), null, 'foreign uid cannot fetch report by id');
  assert.strictEqual(await db.updateReport(bob, report.id, { name: 'stolen' }), null, 'foreign uid cannot update report');
  assert.strictEqual(await db.deleteReport(bob, report.id), false, 'foreign uid cannot delete report');
  assert.ok((await db.listReports(bob)).every((r) => r.id !== report.id), 'foreign list omits report');
});

test('workspace-scoped operational rows deny outsiders but allow members/admins', { skip }, async () => {
  const owner = await mkUser('ops-owner');
  const admin = await mkUser('ops-admin');
  const viewer = await mkUser('ops-viewer');
  const outsider = await mkUser('ops-outsider');
  const ws = await mkWorkspace(owner, `ops-ws-${nonce}`);
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'admin'), ($1, $3, 'viewer')`,
    [ws, admin, viewer]);
  const src = await mkSource(`${nonce}-ops`);
  const ch = await mkChannel(owner, ws, src, `chan_${nonce}_ops`);

  const key = await db.createApiKey(ch, `${nonce}-hash`, `${nonce.slice(0, 8)}_k`, 'ops key');
  assert.ok(key && key.id, 'api key created');
  assert.ok((await db.listApiKeys(ch, admin)).some((k) => k.id === key.id), 'workspace admin can list keys');
  assert.deepStrictEqual(await db.listApiKeys(ch, viewer), [], 'workspace viewer cannot list standing write credentials');
  assert.deepStrictEqual(await db.listApiKeys(ch, outsider), [], 'outsider cannot list keys');

  assert.strictEqual(await db.revokeApiKey(key.id, ch + 9999, admin), false, 'route channel id must match key channel');
  assert.strictEqual(await db.revokeApiKey(key.id, ch, outsider), false, 'outsider cannot revoke key');
  assert.strictEqual(await db.revokeApiKey(key.id, ch, admin), true, 'workspace admin can revoke key');

  await pool.query(
    `INSERT INTO collector_status (channel_id, collector_version, last_ingest_id, last_attempt_at, last_success_at)
     VALUES ($1, 'it', 'ingest-1', now(), now())
     ON CONFLICT (channel_id) DO UPDATE SET collector_version='it', last_ingest_id='ingest-1'`,
    [ch]);
  assert.ok(await db.getCollectorStatus(ch, { uid: viewer }), 'workspace viewer can read source freshness');
  assert.strictEqual(await db.getCollectorStatus(ch, { uid: outsider }), null, 'outsider cannot read collector status');
});

test('two channels linked to ONE source read ONE canonical history row-set', { skip }, async () => {
  const alice = await mkUser('alice');
  const bob = await mkUser('bob');
  const wsA = await mkWorkspace(alice, `wsA-${nonce}`);
  const wsB = await mkWorkspace(bob, `wsB-${nonce}`);
  const src = await mkSource(`${nonce}-canon`);
  const chA = await mkChannel(alice, wsA, src, `chan_${nonce}_alice`);
  const chB = await mkChannel(bob, wsB, src, `chan_${nonce}_bob`);

  // Only Bob's link ever ingested data…
  await db.upsertChannelDaily(chB, [
    { day: '2026-07-01', subscribers: 111, joins: 1, leaves: 0, views: 10, forwards: 1, reactions: 2 },
    { day: '2026-07-02', subscribers: 222, joins: 2, leaves: 1, views: 20, forwards: 2, reactions: 4 },
  ]);

  // …but Alice's channel sees the SAME canonical history (the roadmap acceptance).
  const viaAlice = await db.getChannelHistory(chA, 4000);
  const days = viaAlice.map((r) => r.day);
  assert.deepStrictEqual(days, ['2026-07-01', '2026-07-02']);
  assert.strictEqual(viaAlice[1].subscribers, 222);

  // Both links writing the same day stays ONE canonical row on read (freshest capture wins).
  await db.upsertChannelDaily(chA, [
    { day: '2026-07-02', subscribers: 333, joins: null, leaves: null, views: null, forwards: null, reactions: null },
  ]);
  const deduped = await db.getChannelHistory(chB, 4000);
  assert.strictEqual(deduped.filter((r) => r.day === '2026-07-02').length, 1, 'DISTINCT ON dedupes the shared day');
  assert.strictEqual(deduped.find((r) => r.day === '2026-07-02').subscribers, 333, 'freshest capture wins');
});

test('jobs: duplicate enqueue collapses, failures are retryable, success is cached', { skip }, async () => {
  const key = `${nonce}-job-1`;
  let runs = 0;

  const first = await db.runJobOnce('it_test', key, async () => {
    runs++;
    return { n: runs };
  });
  assert.strictEqual(first.skipped, false);
  assert.strictEqual(runs, 1);

  const dup = await db.runJobOnce('it_test', key, async () => {
    runs++;
    return { n: runs };
  });
  assert.strictEqual(dup.skipped, true, 'succeeded job is not re-run');
  assert.strictEqual(runs, 1, 'work executed exactly once');
  assert.deepStrictEqual(dup.job.result, { n: 1 }, 'duplicate sees the cached result');

  // A failing run leaves the key retryable…
  const failKey = `${nonce}-job-2`;
  await assert.rejects(
    db.runJobOnce('it_test', failKey, async () => { throw new Error('boom'); }),
    /boom/);
  const retried = await db.runJobOnce('it_test', failKey, async () => 'ok');
  assert.strictEqual(retried.skipped, false, 'failed job is claimable again');
  assert.strictEqual(retried.result, 'ok');

  // …and a crashed runner (expired lease) does not block the key forever.
  const crashKey = `${nonce}-job-3`;
  const claimed = await db.claimJob('it_test', crashKey, { leaseSeconds: 0 });
  assert.ok(claimed, 'first claim wins');
  const reclaimed = await db.claimJob('it_test', crashKey, { leaseSeconds: 60 });
  assert.ok(reclaimed, 'expired lease is reclaimable');
  assert.strictEqual(reclaimed.attempts, 2);

  // A live lease blocks concurrent claims.
  const liveKey = `${nonce}-job-4`;
  await db.claimJob('it_test', liveKey, { leaseSeconds: 300 });
  const blocked = await db.claimJob('it_test', liveKey, { leaseSeconds: 300 });
  assert.strictEqual(blocked, null, 'live lease blocks a concurrent claim');
});

test('creation paths canonicalise: createTgChannel gets workspace + shared source', { skip }, async () => {
  const u1 = await mkUser('creator1');
  const u2 = await mkUser('creator2');
  const tgId = 900000000 + (Date.now() % 1000000);

  const chA = await db.createTgChannel({ owner_uid: u1, tg_channel_id: tgId, username: `qr_${nonce}` });
  const chB = await db.createTgChannel({ owner_uid: u2, tg_channel_id: tgId, username: `qr_${nonce}` });
  assert.ok(chA && chB && chA.id !== chB.id, 'two links created');

  const { rows: [a] } = await pool.query(`SELECT workspace_id, source_id FROM channels WHERE id=$1`, [chA.id]);
  const { rows: [b] } = await pool.query(`SELECT workspace_id, source_id FROM channels WHERE id=$1`, [chB.id]);
  assert.ok(a.workspace_id != null && b.workspace_id != null, 'both links joined a personal workspace');
  assert.notStrictEqual(a.workspace_id, b.workspace_id, 'different creators → different workspaces');
  assert.ok(a.source_id != null, 'source stamped');
  assert.strictEqual(a.source_id, b.source_id, 'SAME external channel → SAME canonical source');

  // …which makes the ingest of one link instantly visible through the other.
  await db.upsertChannelDaily(chA.id, [{ day: '2026-07-03', subscribers: 777, joins: 7, leaves: 0, views: 70, forwards: 7, reactions: 7 }]);
  const viaB = await db.getChannelHistory(chB.id, 4000);
  assert.ok(viaB.some((r) => r.day === '2026-07-03' && r.subscribers === 777), 'shared source shares history');

  await pool.query(`DELETE FROM external_sources WHERE id=$1`, [a.source_id]).catch(() => {});
});

test('setChannelTgId INSIDE a transaction does not self-deadlock (verify-round regression)', { skip }, async () => {
  // The exact path that would have frozen the API: collector ingest runs setChannelTgId on its
  // tx client; ensureChannelCanonical must ride the SAME executor (a pool.query would block on
  // the tx's own row lock forever — undetectable by Postgres).
  const u = await mkUser('txuser');
  const ch = await db.createChannel({ owner_uid: u, username: `tx_${nonce}` });
  assert.ok(ch, 'collector channel created (no tg id yet)');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await Promise.race([
      db.setChannelTgId(ch.id, 987650000 + (Date.now() % 10000), client),
      new Promise((_, rej) => setTimeout(() => rej(new Error('self-deadlock: setChannelTgId hung inside the tx')), 5000)),
    ]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const { rows: [row] } = await pool.query(`SELECT source_id, workspace_id FROM channels WHERE id=$1`, [ch.id]);
  assert.ok(row.workspace_id != null, 'workspace stamped through the tx executor');
  assert.ok(row.source_id != null, 'source stamped through the tx executor');
});
