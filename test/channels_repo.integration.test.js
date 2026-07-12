'use strict';

// Integration-тесты channelsRepo (P2 db-split PR 3) — на РЕАЛЬНОМ Postgres. channelsRepo — ядро
// tenant-изоляции (ownership check), поэтому тесты бьют именно по границе доступа: чужой не видит
// канал, член воркспейса видит со своей ролью, api-ключи под admin-гейтом, удаление по владению.
// Без TEST_DATABASE_URL всё SKIP. Гоняется в CI (postgres) и локально:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `chrepo${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = (tag) => `${tag}.${seq++}.${nonce}@it.local`;
let tgSeq = 0;
const usedTg = [];
const tgId = () => { const v = 990_000_000 + (process.pid % 9000) * 1000 + (tgSeq++); usedTg.push(String(v)); return v; };

const mkUser = (tag) => db.createUser({ email: mail(tag), pass_hash: 'x', role: 'user', status: 'active' });
const wsOf = async (chId) => (await pool.query('SELECT workspace_id FROM channels WHERE id=$1', [chId])).rows[0].workspace_id;
const addMember = (ws, uid, role) =>
  pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1,$2,$3)`, [ws, uid, role]);

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
  // Users каскадят channels/workspaces/members/api_keys/annotations. external_sources — общий, не
  // каскадит: чистим по нашему nonce-username и по использованным tg-id.
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM external_sources WHERE username LIKE $1 OR external_id = ANY($2)`, [`%${nonce}%`, usedTg]);
  await pool.end();
});

test('getChannel: владелец видит (member_role=owner), чужой — null, без uid — null', { skip }, async () => {
  const A = await mkUser('a');
  const B = await mkUser('b');
  const ch = await db.createChannel({ owner_uid: A.id, username: `cha_${nonce}`, title: 'A' });
  const asA = await db.getChannel(ch.id, { uid: A.id });
  assert.strictEqual(asA.id, ch.id);
  assert.strictEqual(asA.member_role, 'owner');
  assert.strictEqual(await db.getChannel(ch.id, { uid: B.id }), null, 'посторонний не получает канал');
  assert.strictEqual(await db.getChannel(ch.id, {}), null, 'missing uid → null (не запрашиваем ownership без uid)');
});

test('workspace-член видит канал со своей ролью (и в getChannel, и в listChannels)', { skip }, async () => {
  const A = await mkUser('wa');
  const M = await mkUser('wm');
  const ch = await db.createChannel({ owner_uid: A.id, username: `chw_${nonce}`, title: 'W' });
  const ws = await wsOf(ch.id);
  assert.ok(ws, 'createChannel застолбил личный воркспейс владельца');
  await addMember(ws, M.id, 'member');
  const asM = await db.getChannel(ch.id, { uid: M.id });
  assert.strictEqual(asM.member_role, 'member', 'член воркспейса видит канал со своей ролью');
  const list = await db.listChannels({ uid: M.id });
  assert.ok(list.some((c) => c.id === ch.id), 'канал виден члену в listChannels');
});

test('listChannels: скоуп по владельцу; disabled скрыт даже по прямому id', { skip }, async () => {
  const A = await mkUser('la');
  const C = await mkUser('lc');
  const ch = await db.createChannel({ owner_uid: A.id, username: `chl_${nonce}`, title: 'L' });
  assert.ok((await db.listChannels({ uid: A.id })).some((c) => c.id === ch.id));
  assert.ok(!(await db.listChannels({ uid: C.id })).some((c) => c.id === ch.id), 'чужой не видит канал в списке');
  await pool.query(`UPDATE channels SET status='disabled' WHERE id=$1`, [ch.id]);
  assert.strictEqual(await db.getChannel(ch.id, { uid: A.id }), null, 'disabled скрыт даже по прямому ?channel=id');
  assert.ok(!(await db.listChannels({ uid: A.id })).some((c) => c.id === ch.id), 'disabled скрыт в списке');
});

test('api-keys под admin-гейтом; getChannelByApiKey active→канал, revoked→null', { skip }, async () => {
  const O = await mkUser('ko');
  const ch = await db.createChannel({ owner_uid: O.id, username: `chk_${nonce}`, title: 'K' });
  const hash = `keyhash_${nonce}`;
  const key = await db.createApiKey(ch.id, hash, 'pfx', 'ci');
  assert.ok(key.id);
  const byKey = await db.getChannelByApiKey(hash);
  assert.strictEqual(byKey.id, ch.id, 'активный ключ → его канал');

  assert.strictEqual((await db.listApiKeys(ch.id, O.id)).length, 1, 'владелец видит ключи');
  const M = await mkUser('km');
  const ws = await wsOf(ch.id);
  await addMember(ws, M.id, 'member');
  assert.strictEqual((await db.listApiKeys(ch.id, M.id)).length, 0, 'обычный член — НЕ админ → ключей не видит');
  await pool.query(`UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND uid=$2`, [ws, M.id]);
  assert.strictEqual((await db.listApiKeys(ch.id, M.id)).length, 1, 'админ воркспейса видит ключи');

  const S = await mkUser('ks');
  assert.strictEqual(await db.revokeApiKey(key.id, ch.id, S.id), false, 'посторонний не отзывает ключ');
  assert.strictEqual(await db.revokeApiKey(key.id, ch.id, O.id), true, 'владелец отзывает');
  assert.strictEqual(await db.getChannelByApiKey(hash), null, 'отозванный ключ → null');
});

test('deleteChannel: только владелец; central защищён', { skip }, async () => {
  const O = await mkUser('do');
  const S = await mkUser('ds');
  const ch = await db.createChannel({ owner_uid: O.id, username: `chd_${nonce}`, title: 'D' });
  assert.strictEqual(await db.deleteChannel(ch.id, S.id), false, 'посторонний не удаляет');
  const central = await db.createChannel({ owner_uid: O.id, username: `chc_${nonce}`, title: 'C' });
  await pool.query(`UPDATE channels SET source='central' WHERE id=$1`, [central.id]);
  assert.strictEqual(await db.deleteChannel(central.id, O.id), false, 'central-канал не удаляется владельцем');
  assert.strictEqual(await db.deleteChannel(ch.id, O.id), true, 'владелец удаляет свой');
  assert.strictEqual(await db.getChannelById(ch.id), null, 'канала больше нет');
});

test('createTgChannel идемпотентен per (owner,tg); external_sources дедуплится, метадата fill-only', { skip }, async () => {
  const O = await mkUser('to');
  const tg = tgId();
  const c1 = await db.createTgChannel({ owner_uid: O.id, tg_channel_id: tg, username: `t1_${nonce}`, title: 'T1' });
  const c2 = await db.createTgChannel({ owner_uid: O.id, tg_channel_id: tg, username: `t1b_${nonce}`, title: 'T1b' });
  assert.strictEqual(c2.id, c1.id, 'повторное добавление того же (owner,tg) — тот же канал');
  const cnt = (await pool.query(`SELECT count(*)::int n FROM channels WHERE owner_uid=$1 AND tg_channel_id=$2`, [O.id, tg])).rows[0].n;
  assert.strictEqual(cnt, 1, 'дубликата канала нет');
  const src = await pool.query(`SELECT username FROM external_sources WHERE network='tg' AND external_id=$1`, [String(tg)]);
  assert.strictEqual(src.rows.length, 1, 'один общий source-row на внешнюю identity');
  assert.strictEqual(src.rows[0].username, `t1_${nonce}`, 'метадата fill-only: первый писатель победил, не перезаписан');
});

test('annotations скоуплены по channel_id (список и удаление)', { skip }, async () => {
  const O = await mkUser('ao');
  const ch = await db.createChannel({ owner_uid: O.id, username: `cha1_${nonce}`, title: 'A1' });
  const ch2 = await db.createChannel({ owner_uid: O.id, username: `cha2_${nonce}`, title: 'A2' });
  const a = await db.createAnnotation(ch.id, { day: '2026-01-15', label: 'launch', createdBy: O.id });
  assert.ok(a.id);
  const list = await db.listAnnotations(ch.id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].label, 'launch');
  assert.strictEqual((await db.listAnnotations(ch2.id)).length, 0, 'аннотация не течёт в другой канал');
  assert.strictEqual(await db.deleteAnnotation(a.id, ch2.id), false, 'удаление скоуплено: чужой channel_id не трогает');
  assert.strictEqual(await db.deleteAnnotation(a.id, ch.id), true, 'свой channel_id — удаляет');
});
