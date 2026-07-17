// Integration tests for GDPR erasure/export (F4/F5): db.deleteUserAccount must erase EVERY
// user-linked row (cascade completeness), keep shared identity rows, anonymize the audit trail —
// and db.streamUserExport must stream the archive in bounded keyset pages without leaking
// credentials or foreign channels, with no duplication/omission across page boundaries (incl.
// equal timestamps). Same contour as tenancy.integration.test.js: needs the local stand, SKIPS
// without TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

/** Fake res-коллектор: гоняет реальный streamUserExport в память и парсит собранный JSON.
 *  write→true (без эмуляции backpressure — она покрыта юнит-тестом), end/destroy шлют 'close'. */
function collectorRes() {
  const listeners = {};
  return {
    chunks: [], writableEnded: false, destroyed: false, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    off(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); return this; },
    emit(ev, ...a) { (listeners[ev] || []).slice().forEach((f) => f(...a)); },
    write(s) { this.chunks.push(s); return true; },
    end(cb) { this.writableEnded = true; if (cb) cb(); this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); },
    body() { return this.chunks.join(''); },
  };
}

/** Прогоняет экспорт через фейковый res на выбранном размере страницы и возвращает исход + JSON.
 *  pageSize — per-call override keyset-страницы (тестовый шов; прод-роут его не передаёт). */
async function runExport(uid, { pageSize } = {}) {
  const res = collectorRes();
  let ready = false;
  const outcome = await db.streamUserExport(uid, res, { onReady() { ready = true; }, pageSize });
  return { outcome, ready, res, json: outcome === 'ok' ? JSON.parse(res.body()) : null };
}

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

test('export: streamUserExport carries the archive but never credentials or foreign channels', { skip }, async () => {
  const a = await seedRichUser('exp-a');
  const b = await seedRichUser('exp-b');
  // A is a member of B's workspace — B's channel must NOT appear in A's export.
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'member')`, [b.ws, a.uid]);

  await pool.query(`UPDATE users SET avatar_url='data:image/png;base64,AVATAR' WHERE id=$1`, [a.uid]);

  const { outcome, ready, res, json: data } = await runExport(a.uid);
  assert.strictEqual(outcome, 'ok', 'stream completed');
  assert.strictEqual(ready, true, 'onReady fired before the first byte');
  assert.strictEqual(res.headers['Cache-Control'], undefined, 'headers are the route’s job (onReady), not the service');
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
  const flat = res.body();
  for (const secret of ['SECRET_TG_SESSION', 'SECRET_IG_TOKEN', 'pass_hash', 'session_enc', 'access_token_enc', 'token_version']) {
    assert.ok(!flat.includes(secret), `export must not contain ${secret}`);
  }

  const exportedIds = data.channels.map((c) => c.id);
  assert.ok(!exportedIds.includes(b.ch), 'membership channel (foreign data) excluded');
});

test('export: keyset pages tile the archive with no duplication/omission, incl. equal timestamps', { skip }, async () => {
  const a = await seedRichUser('page-a');
  // seedRichUser already added day0 daily + 1 post + 1 ig_daily + 1 annotation. Pile on more so the
  // archive spans several pages at pageSize=2, and force a DUPLICATE date_published so the post
  // keyset must lean on its (date_published, post_id) tie-breaker to avoid dupes/holes on a boundary.
  const day = (n) => `(CURRENT_DATE - ${n})`;
  for (let n = 1; n <= 4; n++) {
    await pool.query(`INSERT INTO channel_daily (channel_id, day, views) VALUES ($1, ${day(n)}, $2)`, [a.ch, n]);
    await pool.query(`INSERT INTO ig_daily (channel_id, day, reach) VALUES ($1, ${day(n)}, $2)`, [a.ch, n]);
    await pool.query(
      `INSERT INTO ig_media_daily (channel_id, media_id, day, reach) VALUES ($1, $2, ${day(n)}, $3)`,
      [a.ch, `media-${n}`, n]);
    await pool.query(`INSERT INTO chart_annotations (channel_id, day, label, created_by) VALUES ($1, ${day(n)}, $2, $3)`,
      [a.ch, `ann-${n}`, a.uid]);
  }
  // Eight posts: two share the SAME date_published, and three have NULL date_published. The NULL
  // tail forces real PostgreSQL through the dense-placeholder branch on a page boundary.
  const sameTs = '2024-03-03T10:00:00.000Z';
  const tsList = [
    sameTs, sameTs, '2024-03-01T00:00:00Z', '2024-03-02T00:00:00Z',
    '2024-03-04T00:00:00Z', null, null, null,
  ];
  for (const ts of tsList) {
    const pid = nextPostId++;
    await pool.query(`INSERT INTO posts (post_id, channel_id, date_published, views) VALUES ($1, $2, $3, 1)`,
      [pid, a.ch, ts]);
  }

  // Whole archive fetched in one shot (large page) is the reference; small pages must match it exactly.
  const big = (await runExport(a.uid, { pageSize: 1000 })).json.channels[0].archive;
  const small = (await runExport(a.uid, { pageSize: 2 })).json.channels[0].archive;

  for (const arr of ['daily', 'posts', 'mentions', 'velocity', 'annotations']) {
    assert.deepStrictEqual(small[arr], big[arr], `${arr}: paged read equals single-shot read`);
  }
  // Every post present exactly once (no dupes, no holes) despite the shared timestamp + page split.
  assert.strictEqual(small.posts.length, 8 + 1, 'all posts incl. seed post, exactly once');
  const gotIds = small.posts.map((p) => String(p.post_id)).sort();
  const wantIds = big.posts.map((p) => String(p.post_id)).sort();
  assert.deepStrictEqual(gotIds, wantIds, 'post_id set identical — no duplication or omission');
  // Deterministic order: date_published asc, post_id asc — the two equal-ts posts sit adjacent, ordered by id.
  const eq = small.posts
    .filter((p) => p.date_published && new Date(p.date_published).toISOString() === sameTs)
    .map((p) => String(p.post_id));
  assert.deepStrictEqual(eq, [...eq].sort((x, y) => Number(x) - Number(y)), 'equal timestamps break ties by ascending post_id');
  assert.strictEqual(small.posts.filter((p) => p.date_published == null).length, 3,
    'NULL timestamp tail crosses pages without omission');

  const igSmall = (await runExport(a.uid, { pageSize: 2 })).json.channels[0].instagram;
  const igBig = (await runExport(a.uid, { pageSize: 1000 })).json.channels[0].instagram;
  assert.deepStrictEqual(igSmall.daily, igBig.daily, 'ig daily: paged equals single-shot');
  assert.deepStrictEqual(igSmall.media_daily, igBig.media_daily, 'ig media: paged equals single-shot');
});

test('export: workspaces, reports and the channel list also tile in keyset pages (bounded head)', { skip }, async () => {
  const a = await seedRichUser('head-a');
  // Team-workspaces не ограничены partial unique для personal, поэтому добавляем два: все три
  // top-level набора должны пересечь pageSize=2 без опоры на продуктовые cap'ы.
  for (const n of [1, 2]) {
    const { rows: [w] } = await pool.query(
      `INSERT INTO workspaces (name, owner_uid, kind) VALUES ($1, $2, 'team') RETURNING id`,
      [`team-${nonce}-${n}`, a.uid]);
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'owner')`,
      [w.id, a.uid]);
  }
  // Two more reports + a second channel make the remaining head sets span pageSize=2 too.
  for (const n of [1, 2]) {
    await pool.query(`INSERT INTO reports (uid, name, config) VALUES ($1, $2, '{"blocks":[]}'::jsonb)`,
      [a.uid, `report2-${nonce}-${n}`]);
  }
  const src2 = await mkSource(`${nonce}-head-2`);
  const ch2 = await mkChannel(a.uid, a.ws, src2, `chan2_${nonce}_head`);
  await pool.query(`INSERT INTO channel_daily (channel_id, day, views) VALUES ($1, CURRENT_DATE, 7)`, [ch2]);

  const big = (await runExport(a.uid, { pageSize: 1000 })).json;
  const small = (await runExport(a.uid, { pageSize: 2 })).json;

  assert.deepStrictEqual(small.workspaces, big.workspaces, 'workspaces: paged read equals single-shot');
  assert.strictEqual(small.workspaces.length, 3, 'personal + two team workspaces, exactly once');
  assert.deepStrictEqual(small.reports, big.reports, 'reports: paged read equals single-shot');
  assert.strictEqual(small.reports.length, 3, 'all three reports, exactly once across page boundaries');
  assert.deepStrictEqual(small.channels, big.channels, 'channel list: paged read equals single-shot');
  assert.strictEqual(small.channels.length, 2, 'both channels present across the paged list');
});

test('export: a missing user streams nothing and reports not_found', { skip }, async () => {
  const { outcome, ready, res } = await runExport(2_000_000_000);
  assert.strictEqual(outcome, 'not_found');
  assert.strictEqual(ready, false, 'onReady not fired — 404 still possible');
  assert.strictEqual(res.chunks.length, 0, 'not a single byte written');
});

test('erasure: deleting one user twice is a clean false, not an error', { skip }, async () => {
  const uid = await mkUser('era-twice');
  assert.strictEqual(await db.deleteUserAccount(uid), true);
  assert.strictEqual(await db.deleteUserAccount(uid), false, 'second delete reports nothing to erase');
});
