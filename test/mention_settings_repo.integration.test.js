'use strict';

// Integration-тесты mentionSettingsRepo — на РЕАЛЬНОМ Postgres. Без TEST_DATABASE_URL всё SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
// Проверяем: owner upsert+read, viewer read-but-no-write, посторонний deny, изоляция второго канала.

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `ment${Date.now().toString(36)}${process.pid}`;
const mail = (tag) => `${tag}.${nonce}@it.local`;
const S = {};

const wsOf = async (chId) => (await pool.query('SELECT workspace_id FROM channels WHERE id=$1', [chId])).rows[0].workspace_id;
const addMember = (ws, uid, role) =>
  pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1,$2,$3)
              ON CONFLICT (workspace_id, uid) DO UPDATE SET role=EXCLUDED.role`, [ws, uid, role]);

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });

  S.owner = await db.createUser({ email: mail('owner'), pass_hash: 'x', role: 'user', status: 'active' });
  S.viewer = await db.createUser({ email: mail('viewer'), pass_hash: 'x', role: 'user', status: 'active' });
  S.stranger = await db.createUser({ email: mail('stranger'), pass_hash: 'x', role: 'user', status: 'active' });

  S.chA = await db.createTgChannel({
    owner_uid: S.owner.id, tg_channel_id: Date.now(), username: `mena_${nonce}`, title: 'Chan A',
  });
  S.chB = await db.createTgChannel({
    owner_uid: S.owner.id, tg_channel_id: Date.now() + 5, username: `menb_${nonce}`, title: 'Chan B',
  });
  // Viewer — участник воркспейса канала A с ролью viewer (может читать, не может писать).
  await addMember(await wsOf(S.chA.id), S.viewer.id, 'viewer');
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${nonce}%`]);
  await pool.query('DELETE FROM external_sources WHERE username LIKE $1', [`%${nonce}%`]);
  await pool.end();
  if (db) await db.close();
});

const asUser = (u) => ({ uid: u.id });

test('owner: upsert пишет и нормализует, read возвращает configured', { skip }, async () => {
  const rules = {
    include_terms: ['notem', 'Мой бренд'],
    exclude_terms: ['spam'],
    exclude_sources: ['bynotem', '12345'],
    match_mode: 'word',
  };
  const written = await db.upsertMentionSettingsForActor(S.chA.id, asUser(S.owner), rules);
  assert.ok(written, 'owner может писать');
  assert.strictEqual(written.configured, true);
  assert.deepStrictEqual(written.include_terms, ['notem', 'Мой бренд']);
  assert.deepStrictEqual(written.exclude_sources, ['bynotem', '12345']);
  assert.strictEqual(written.match_mode, 'word');
  assert.ok(written.updated_at);

  const read = await db.getMentionSettingsForActor(S.chA.id, asUser(S.owner));
  assert.strictEqual(read.configured, true);
  assert.deepStrictEqual(read.include_terms, ['notem', 'Мой бренд']);

  // upsert идемпотентен: второй вызов обновляет ту же строку.
  const upd = await db.upsertMentionSettingsForActor(S.chA.id, asUser(S.owner),
    { include_terms: ['only'], exclude_terms: [], exclude_sources: [], match_mode: 'contains' });
  assert.deepStrictEqual(upd.include_terms, ['only']);
  assert.strictEqual(upd.match_mode, 'contains');
});

test('viewer: может читать, НЕ может писать', { skip }, async () => {
  const read = await db.getMentionSettingsForActor(S.chA.id, asUser(S.viewer));
  assert.ok(read, 'viewer видит канал → читает настройки');
  assert.strictEqual(read.configured, true);

  const write = await db.upsertMentionSettingsForActor(S.chA.id, asUser(S.viewer),
    { include_terms: ['hacked'], exclude_terms: [], exclude_sources: [], match_mode: 'contains' });
  assert.strictEqual(write, null, 'viewer не может писать (SQL-boundary отвергает)');

  // Правила не изменились после отказанной записи viewer.
  const after = await db.getMentionSettingsForActor(S.chA.id, asUser(S.owner));
  assert.deepStrictEqual(after.include_terms, ['only']);
});

test('посторонний: read и write → null (deny без утечки)', { skip }, async () => {
  assert.strictEqual(await db.getMentionSettingsForActor(S.chA.id, asUser(S.stranger)), null);
  const write = await db.upsertMentionSettingsForActor(S.chA.id, asUser(S.stranger),
    { include_terms: ['x'], exclude_terms: [], exclude_sources: [], match_mode: 'contains' });
  assert.strictEqual(write, null);
});

test('изоляция каналов: канал B независим от A', { skip }, async () => {
  const bBefore = await db.getMentionSettingsForActor(S.chB.id, asUser(S.owner));
  assert.strictEqual(bBefore.configured, false, 'B ещё не настроен, даже когда A настроен');

  await db.upsertMentionSettingsForActor(S.chB.id, asUser(S.owner),
    { include_terms: ['brandB'], exclude_terms: [], exclude_sources: [], match_mode: 'contains' });
  const b = await db.getMentionSettingsForActor(S.chB.id, asUser(S.owner));
  const a = await db.getMentionSettingsForActor(S.chA.id, asUser(S.owner));
  assert.deepStrictEqual(b.include_terms, ['brandB']);
  assert.deepStrictEqual(a.include_terms, ['only'], 'запись в B не тронула A');
});

test('internal read: без access-check возвращает EMPTY для ненастроенного канала', { skip }, async () => {
  const fresh = await db.createTgChannel({
    owner_uid: S.owner.id, tg_channel_id: Date.now() + 99, username: `menc_${nonce}`, title: 'Chan C',
  });
  const internal = await db.getMentionSettingsInternal(fresh.id);
  assert.strictEqual(internal.configured, false);
  assert.deepStrictEqual(internal.include_terms, []);
  assert.strictEqual(internal.match_mode, 'contains');
});
