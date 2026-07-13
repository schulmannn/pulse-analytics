'use strict';

// Integration-тесты sourcesRepo (P2 db-split PR 7.5, finding 8) — на РЕАЛЬНОМ Postgres.
// external_sources — дедуплицированная identity внешней площадки (одна строка на network+external_id,
// общая для воркспейсов). Метадата fill-only (первый писатель побеждает — нет bleed между линками).
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `src${Date.now().toString(36)}${process.pid}`;
let extSeq = 0;
const usedExt = [];
const extId = () => { const v = `ext.${nonce}.${extSeq++}`; usedExt.push(v); return v; };

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM external_sources WHERE external_id = ANY($1) OR username LIKE $2`, [usedExt, `%${nonce}%`]);
  await pool.end();
});

test('ensureExternalSource: find-or-create, дедуп по (network, external_id) → один id', { skip }, async () => {
  const ext = extId();
  const id1 = await db.ensureExternalSource('tg', ext, { username: `u.${nonce}`, title: 'T1' });
  assert.ok(id1, 'вернул id');
  const id2 = await db.ensureExternalSource('tg', ext, { username: `other.${nonce}`, title: 'T2' });
  assert.strictEqual(id2, id1, 'тот же (network, external_id) → тот же id (дедуп)');
  const n = (await pool.query(`SELECT count(*)::int n FROM external_sources WHERE network='tg' AND external_id=$1`, [ext])).rows[0].n;
  assert.strictEqual(n, 1, 'ровно одна строка identity');
});

test('ensureExternalSource: метадата fill-only — первый писатель побеждает, NULL добивается', { skip }, async () => {
  const ext = extId();
  await db.ensureExternalSource('tg', ext, { username: `first.${nonce}`, title: null });   // title NULL
  await db.ensureExternalSource('tg', ext, { username: `second.${nonce}`, title: `Title.${nonce}` }); // username занят, title пуст → добьётся
  const row = (await pool.query(`SELECT username, title FROM external_sources WHERE network='tg' AND external_id=$1`, [ext])).rows[0];
  assert.strictEqual(row.username, `first.${nonce}`, 'username не перезаписан (fill-only, нет bleed)');
  assert.strictEqual(row.title, `Title.${nonce}`, 'NULL-title добит вторым писателем');
});

test('ensureExternalSource: разные network — разные identity', { skip }, async () => {
  const ext = extId();
  const tg = await db.ensureExternalSource('tg', ext, { username: `x.${nonce}` });
  const ig = await db.ensureExternalSource('ig', ext, { username: `x.${nonce}` });
  assert.notStrictEqual(tg, ig, 'один external_id в разных сетях — разные строки');
});
