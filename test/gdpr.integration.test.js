// Integration tests for GDPR erasure/export (F4/F5): db.deleteUserAccount must erase EVERY
// user-linked row (cascade completeness), keep shared identity rows, anonymize the audit trail —
// and db.exportUserData must never leak credentials. Same contour as tenancy.integration.test.js:
// needs the local stand, SKIPS without TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `g${Date.now().toString(36)}${process.pid}`;

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE external_id LIKE $1`, [`${nonce}%`]);
  await pool.query(`DELETE FROM audit_events WHERE action LIKE $1`, [`it.${nonce}%`]);
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

/** Seed the full personal-data footprint for one user and return every id needed for asserts. */
async function seedRichUser(tag) {
  const uid = await mkUser(tag);
  const ws = await mkWorkspace(uid, `ws-${tag}-${nonce}`);
  const src = await mkSource(`${nonce}-${tag}`);
  const ch = await mkChannel(uid, ws, src, `chan_${nonce}_${tag}`);
  await pool.query(`INSERT INTO user_prefs (uid, prefs) VALUES ($1, '{"h":1}'::jsonb)`, [uid]);
  await pool.query(
    `INSERT INTO tg_sessions (uid, tg_user_id, username, session_enc) VALUES ($1, 1, $2, 'iv:tag:SECRET_TG_SESSION')`,
    [uid, tag]);
  await pool.query(
    `INSERT INTO reports (uid, name, config) VALUES ($1, $2, '{"blocks":[]}'::jsonb)`,
    [uid, `report-${nonce}-${tag}`]);
  await pool.query(
    `INSERT INTO channel_daily (channel_id, day, views) VALUES ($1, CURRENT_DATE, 100)`, [ch]);
  await pool.query(
    `INSERT INTO posts (post_id, channel_id, date_published, views) VALUES ($1, $2, now(), 50)`,
    [nextPostId++, ch]);
  await pool.query(
    `INSERT INTO ig_accounts (channel_id, ig_user_id, username, access_token_enc)
     VALUES ($1, $2, $2, 'iv:tag:SECRET_IG_TOKEN')`, [ch, `ig_${nonce}_${tag}`]);
  await pool.query(
    `INSERT INTO ig_daily (channel_id, day, reach) VALUES ($1, CURRENT_DATE, 10)`, [ch]);
  await pool.query(
    `INSERT INTO chart_annotations (channel_id, day, label, created_by) VALUES ($1, CURRENT_DATE, 'launch', $2)`,
    [ch, uid]);
  await pool.query(
    `INSERT INTO channel_mention_settings
       (channel_id, include_terms, exclude_terms, exclude_sources, match_mode, updated_by)
     VALUES ($1, ARRAY['brand'], ARRAY['spam'], ARRAY['noise'], 'word', $2)`,
    [ch, uid]);
  return { uid, ws, src, ch };
}

// posts.post_id is a global BIGINT PK (TG message ids in prod) — synthesize unique ones per run.
let nextPostId = Date.now();

const count = async (sql, params) =>
  parseInt((await pool.query(sql, params)).rows[0].count, 10);

test('erasure: deleteUserAccount removes every user-linked row, spares neighbours and shared identity', { skip }, async () => {
  const a = await seedRichUser('era-a');
  const b = await seedRichUser('era-b');

  // B is a member of A's workspace AND parked a channel there (the un-enforced invariant says
  // channels live in their creator's personal workspace — erasure must survive its violation).
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`, [a.ws, b.uid]);
  const srcForeign = await mkSource(`${nonce}-era-foreign`);
  const foreignCh = await mkChannel(b.uid, a.ws, srcForeign, `chan_${nonce}_era_foreign`);

  // A SHARED source: B's second channel claims A's source too — it must survive the sweep.
  const sharedCh = await mkChannel(b.uid, b.ws, a.src, `chan_${nonce}_era_shared`);

  // An audit row pointing at A with identifying metadata (the tg.session.connected shape):
  // erasure must keep the row but anonymize BOTH uid (SET NULL) and metadata (wipe).
  const { rows: [ev] } = await pool.query(
    `INSERT INTO audit_events (uid, action, metadata) VALUES ($1, $2, '{"username":"personal_tg_handle"}'::jsonb) RETURNING id`,
    [a.uid, `it.${nonce}.era`]);

  assert.strictEqual(await db.deleteUserAccount(a.uid), true, 'reports the deletion');

  // Everything of A is gone — walk every user-linked table.
  for (const [label, sql, params] of [
    ['users', `SELECT count(*) FROM users WHERE id=$1`, [a.uid]],
    ['user_prefs', `SELECT count(*) FROM user_prefs WHERE uid=$1`, [a.uid]],
    ['tg_sessions', `SELECT count(*) FROM tg_sessions WHERE uid=$1`, [a.uid]],
    ['reports', `SELECT count(*) FROM reports WHERE uid=$1`, [a.uid]],
    ['workspaces', `SELECT count(*) FROM workspaces WHERE owner_uid=$1`, [a.uid]],
    ['workspace_members', `SELECT count(*) FROM workspace_members WHERE uid=$1`, [a.uid]],
    ['channels', `SELECT count(*) FROM channels WHERE id=$1`, [a.ch]],
    ['channel_daily', `SELECT count(*) FROM channel_daily WHERE channel_id=$1`, [a.ch]],
    ['posts', `SELECT count(*) FROM posts WHERE channel_id=$1`, [a.ch]],
    ['channel_mention_settings', `SELECT count(*) FROM channel_mention_settings WHERE channel_id=$1`, [a.ch]],
    ['ig_accounts', `SELECT count(*) FROM ig_accounts WHERE channel_id=$1`, [a.ch]],
    ['ig_daily', `SELECT count(*) FROM ig_daily WHERE channel_id=$1`, [a.ch]],
    ['chart_annotations', `SELECT count(*) FROM chart_annotations WHERE channel_id=$1`, [a.ch]],
  ]) {
    assert.strictEqual(await count(sql, params), 0, `${label}: erased`);
  }

  // B is untouched, including the channel that lived in A's (now deleted) workspace.
  assert.strictEqual(await count(`SELECT count(*) FROM users WHERE id=$1`, [b.uid]), 1, 'neighbour user survives');
  assert.strictEqual(await count(`SELECT count(*) FROM channels WHERE id=$1`, [b.ch]), 1, 'neighbour channel survives');
  const { rows: [fc] } = await pool.query(`SELECT workspace_id, owner_uid FROM channels WHERE id=$1`, [foreignCh]);
  assert.ok(fc, 'foreign channel in the dying workspace survives');
  assert.strictEqual(fc.workspace_id, null, 'foreign channel falls back to the legacy NULL-workspace path');
  assert.strictEqual(fc.owner_uid, b.uid, 'foreign channel keeps its owner');

  // Source claimed by a SURVIVOR = shared identity → survives. Source referenced by NOBODY
  // after the cascade (srcForeign belongs to the surviving foreign channel; B's own src too) —
  // but a truly orphaned one must be swept: give A a second, sole-claim source via seedRichUser?
  // a.src is shared (sharedCh claims it) → survives; srcForeign/b.src still referenced → survive.
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [a.src]), 1,
    'source still claimed by a survivor is shared identity and survives');
  assert.strictEqual(await count(`SELECT count(*) FROM channels WHERE id=$1`, [sharedCh]), 1,
    'survivor channel on the shared source is intact');

  // Audit row: survives, anonymized in BOTH columns.
  const { rows: [after] } = await pool.query(`SELECT uid, metadata FROM audit_events WHERE id=$1`, [ev.id]);
  assert.ok(after, 'audit row survives erasure');
  assert.strictEqual(after.uid, null, 'audit row is anonymized (SET NULL)');
  assert.deepStrictEqual(after.metadata, {}, 'identifying metadata is wiped');
});

test('erasure: a source claimed ONLY by the erased user (private channel) is swept away', { skip }, async () => {
  const a = await seedRichUser('orph-a');
  assert.strictEqual(await db.deleteUserAccount(a.uid), true);
  assert.strictEqual(await count(`SELECT count(*) FROM external_sources WHERE id=$1`, [a.src]), 0,
    'orphaned source (its username/title can identify a private channel owner) is erased');
});

test('export: exportUserData carries the archive but never credentials or foreign channels', { skip }, async () => {
  const a = await seedRichUser('exp-a');
  const b = await seedRichUser('exp-b');
  // A is a member of B's workspace — B's channel must NOT appear in A's export.
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`, [b.ws, a.uid]);

  await pool.query(`UPDATE users SET avatar_url='data:image/png;base64,AVATAR' WHERE id=$1`, [a.uid]);

  const data = await db.exportUserData(a.uid);
  assert.ok(data, 'export exists');
  assert.strictEqual(data.account.id, a.uid);
  assert.strictEqual(data.account.avatar_url, 'data:image/png;base64,AVATAR', 'avatar (personal photo) exported');
  assert.strictEqual(data.channels.length, 1, 'only owned channels are exported');
  assert.strictEqual(data.channels[0].id, a.ch);
  assert.strictEqual(data.channels[0].archive.daily.length, 1, 'daily archive included');
  assert.strictEqual(data.channels[0].archive.posts.length, 1, 'posts archive included');
  assert.deepStrictEqual(data.channels[0].mention_settings.include_terms, ['brand'], 'mention rules included');
  assert.strictEqual(data.channels[0].mention_settings.match_mode, 'word');
  assert.ok(data.channels[0].instagram, 'ig profile included');
  assert.strictEqual(data.channels[0].instagram.daily.length, 1, 'ig daily included');
  assert.ok(data.telegram_session, 'tg connection presence included');
  assert.deepStrictEqual(data.prefs, { h: 1 }, 'prefs included');

  // The credential blacklist: nothing that smells like a secret may appear ANYWHERE in the JSON.
  const flat = JSON.stringify(data);
  for (const secret of ['SECRET_TG_SESSION', 'SECRET_IG_TOKEN', 'pass_hash', 'session_enc', 'access_token_enc', 'token_version']) {
    assert.ok(!flat.includes(secret), `export must not contain ${secret}`);
  }

  const exportedIds = data.channels.map((c) => c.id);
  assert.ok(!exportedIds.includes(b.ch), 'membership channel (foreign data) excluded');
});

test('erasure: deleting one user twice is a clean false, not an error', { skip }, async () => {
  const uid = await mkUser('era-twice');
  assert.strictEqual(await db.deleteUserAccount(uid), true);
  assert.strictEqual(await db.deleteUserAccount(uid), false, 'second delete reports nothing to erase');
});
