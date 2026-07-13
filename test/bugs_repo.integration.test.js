'use strict';

// Integration-тесты bugsRepo (P2 db-split PR 5) — на РЕАЛЬНОМ Postgres. Домен без тенантности
// (глобальный admin-трекер): баги/фичи, crash-телеметрия (kind='crash'), dedup-леджер сигнатур
// (crash_signatures) и вложения с атомарным кэпом. Без TEST_DATABASE_URL всё SKIP.
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `bug${Date.now().toString(36)}${process.pid}`;
let sigSeq = 0;
const sig = () => `s.${nonce}.${sigSeq++}`;

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM bug_attachments WHERE bug_id IN (SELECT id FROM bugs WHERE text LIKE $1)`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM bugs WHERE text LIKE $1`, [`%${nonce}%`]);
  await pool.query(`DELETE FROM crash_signatures WHERE signature LIKE $1`, [`s.${nonce}%`]);
  await pool.end();
});

test('bug lifecycle: create → list → update(status) → delete; невалидный статус throw', { skip }, async () => {
  const b = await db.createBug({ text: `bug ${nonce}`, severity: 'high', context: 'ctx', kind: 'feature' });
  assert.ok(b.id);
  assert.strictEqual(b.status, 'open', 'новый баг — open');
  assert.strictEqual(b.severity, 'high');
  assert.strictEqual(b.kind, 'feature');
  assert.ok((await db.listBugs('open')).some((x) => x.id === b.id), 'виден в listBugs(open)');
  assert.ok(await db.bugExists(b.id));

  const upd = await db.updateBug(b.id, 'in_progress');
  assert.strictEqual(upd.status, 'in_progress');
  await assert.rejects(() => db.updateBug(b.id, 'nope'), /bad status/, 'невалидный статус — throw');

  assert.strictEqual(await db.deleteBug(b.id), true);
  assert.strictEqual(await db.bugExists(b.id), false, 'после удаления — нет');
});

test('createBug клампит невалидные severity/kind к дефолтам (medium/bug)', { skip }, async () => {
  const b = await db.createBug({ text: `clamp ${nonce}`, severity: 'ULTRA', kind: 'xxx' });
  assert.strictEqual(b.severity, 'medium', 'severity вне справочника → medium');
  assert.strictEqual(b.kind, 'bug', 'kind вне справочника → bug');
});

test('createCrash: kind=crash, severity=high, длинный context (8000) влезает', { skip }, async () => {
  const longCtx = `stack ${nonce} ` + 'x'.repeat(6000);
  const c = await db.createCrash({ text: `crash ${nonce}`, context: longCtx });
  assert.strictEqual(c.kind, 'crash');
  assert.strictEqual(c.severity, 'high');
  const got = await db.getBug(c.id);
  assert.ok(got.context.length > 500, 'crash-context не обрезан до 500 (user-cap), влезает больше');
});

test('upsertCrashSignature: первый → isNew+count1, повтор → !isNew+count2, last_trace_id ротируется', { skip }, async () => {
  const signature = sig();
  const first = await db.upsertCrashSignature({ signature, scope: 'widget', name: 'TypeError', message: 'boom', traceId: 't1' });
  assert.strictEqual(first.isNew, true, 'первое появление — новая сигнатура');
  assert.strictEqual(first.count, 1);
  const second = await db.upsertCrashSignature({ signature, scope: 'widget', name: 'TypeError', message: 'boom', traceId: 't2' });
  assert.strictEqual(second.isNew, false, 'повтор — не новая (UPDATE-ветка через xmax)');
  assert.strictEqual(second.count, 2, 'count инкрементнулся');
  const row = (await pool.query(`SELECT last_trace_id FROM crash_signatures WHERE signature=$1`, [signature])).rows[0];
  assert.strictEqual(row.last_trace_id, 't2', 'last_trace_id — последний');
});

test('setCrashNotionPage / touchCrashNotified проставляют notion_page_id + last_notified', { skip }, async () => {
  const signature = sig();
  await db.upsertCrashSignature({ signature, name: 'E', message: 'm', traceId: 't' });
  await db.setCrashNotionPage(signature, 'notion-123');
  const after = await db.upsertCrashSignature({ signature, name: 'E', message: 'm', traceId: 't2' });
  assert.strictEqual(after.notionPageId, 'notion-123', 'notion_page_id виден в последующем upsert');
  assert.ok(after.lastNotified, 'last_notified установлен (окно троттлинга)');
});

test('addAttachmentIfRoom: атомарный кэп — до max вставляет, дальше null; getBug.attachment_count растёт', { skip }, async () => {
  const b = await db.createBug({ text: `att ${nonce}`, severity: 'low', kind: 'bug' });
  const buf = Buffer.from('data');
  const a1 = await db.addAttachmentIfRoom(b.id, 'image/png', buf, 2);
  const a2 = await db.addAttachmentIfRoom(b.id, 'image/png', buf, 2);
  const a3 = await db.addAttachmentIfRoom(b.id, 'image/png', buf, 2);
  assert.ok(a1 && a2, 'первые два вложения вставлены');
  assert.strictEqual(a3, null, 'третье при max=2 — null (кэп закрыт атомарно)');
  assert.strictEqual((await db.getBug(b.id)).attachment_count, 2, 'attachment_count = 2');
  const got = await db.getAttachment(a1.id);
  assert.strictEqual(got.mime, 'image/png');
  assert.ok(Buffer.isBuffer(got.data) || got.data, 'data отдаётся');
});
