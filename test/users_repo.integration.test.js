'use strict';

// Integration-тесты usersRepo (P2 db-split PR 2) — на РЕАЛЬНОМ Postgres. Без TEST_DATABASE_URL всё
// SKIP'ается (как tenancy/gdpr/ark). Гоняются в CI (postgres-сервис) и на локальном стенде:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
// Каждый прогон работает на своих строках (nonce в email) и чистит за собой.

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `urepo${Date.now().toString(36)}${process.pid}`;
const mail = (tag) => `${tag}.${nonce}@it.local`;

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM user_prefs   WHERE uid IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM email_tokens WHERE uid IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.end();
});

test('createUser + getUserById/ByEmail: круговой рейс, pass_hash только по email', { skip }, async () => {
  const created = await db.createUser({ email: mail('a'), pass_hash: 'hash-a', role: 'user', status: 'active' });
  assert.ok(created && created.id, 'createUser вернул id');
  assert.strictEqual(created.role, 'user');
  assert.strictEqual(created.status, 'active');

  const byId = await db.getUserById(created.id);
  assert.strictEqual(byId.email, mail('a'));
  assert.strictEqual(byId.pass_hash, undefined, 'getUserById НЕ отдаёт pass_hash');

  const byEmail = await db.getUserByEmail(mail('a').toUpperCase()); // регистронезависимо
  assert.strictEqual(byEmail.id, created.id);
  assert.strictEqual(byEmail.pass_hash, 'hash-a', 'getUserByEmail отдаёт pass_hash для проверки логина');
});

test('token_version++ на revoke / setUserPassword / updateUser(status)', { skip }, async () => {
  const u = await db.createUser({ email: mail('tv'), pass_hash: 'x', role: 'user', status: 'active' });
  const v0 = u.token_version;

  await db.revokeUserSessions(u.id);
  const v1 = (await db.getUserById(u.id)).token_version;
  assert.strictEqual(v1, v0 + 1, 'revokeUserSessions поднимает token_version');

  await db.setUserPassword(u.id, 'newhash');
  const v2 = (await db.getUserById(u.id)).token_version;
  assert.strictEqual(v2, v1 + 1, 'setUserPassword поднимает token_version (разлогинивает старые сессии)');

  await db.updateUser(u.id, { status: 'disabled' });
  const v3 = (await db.getUserById(u.id)).token_version;
  assert.strictEqual(v3, v2 + 1, 'updateUser тоже бампает token_version');
});

test('setUserStatus: disabled сохраняется + бампает token_version; невалидный статус — throw', { skip }, async () => {
  const u = await db.createUser({ email: mail('st'), pass_hash: 'x', role: 'user', status: 'active' });
  const disabled = await db.setUserStatus(u.id, 'disabled');
  assert.strictEqual(disabled.status, 'disabled');
  assert.strictEqual(disabled.token_version, u.token_version + 1);
  const reread = await db.getUserById(u.id);
  assert.strictEqual(reread.status, 'disabled', 'disabled-статус виден в getUserById (auth-слой не пустит как active)');
  await assert.rejects(() => db.setUserStatus(u.id, 'not-a-status'), /bad status/);
});

test('email token одноразовый: первый use → {uid}, второй → null', { skip }, async () => {
  const u = await db.createUser({ email: mail('et'), pass_hash: 'x', role: 'user', status: 'unverified' });
  const hash = `tokhash-${nonce}`;
  const tokenId = await db.createEmailToken(u.id, 'verify', hash, new Date(Date.now() + 60000));
  assert.ok(tokenId, 'createEmailToken вернул id');

  const first = await db.useEmailToken(hash, 'verify');
  assert.deepStrictEqual(first, { uid: u.id }, 'первое использование возвращает { uid }');

  const second = await db.useEmailToken(hash, 'verify');
  assert.strictEqual(second, null, 'повторное использование того же токена — null (одноразовый)');
});

test('prefs изоляция: setPrefs(A) виден A, не виден B', { skip }, async () => {
  const a = await db.createUser({ email: mail('pa'), pass_hash: 'x', role: 'user', status: 'active' });
  const b = await db.createUser({ email: mail('pb'), pass_hash: 'x', role: 'user', status: 'active' });
  await db.setPrefs(a.id, { theme: 'dark', pinned: [1, 2] });
  assert.deepStrictEqual(await db.getPrefs(a.id), { theme: 'dark', pinned: [1, 2] });
  assert.strictEqual(await db.getPrefs(b.id), null, 'prefs пользователя A недоступны пользователю B');
});
