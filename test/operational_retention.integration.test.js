'use strict';

// Integration tests (real Postgres) for the bounded operational retention added to the daily
// maintenance job: jobsRepo.pruneTerminalJobs + usersRepo.pruneEmailTokens. They prove the actual
// DELETE predicates against a live schema — boundary timestamps, batch cap + repeat-run drain, and
// that PROTECTED rows (queued/running jobs; valid unused tokens) survive. Run against the local
// stand exactly like the other *.integration.test.js:
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:54329/pulse npm test
//
// Without TEST_DATABASE_URL every test SKIPS. Each scenario gets a private schema because the
// production prune is intentionally table-global; isolated search_path values keep parallel Node
// test contexts from consuming one another's cap fixtures.

const test = require('node:test');
const assert = require('node:assert');
const { createJobsRepo } = require('../server/repos/jobsRepo');
const { createUsersRepo } = require('../server/repos/usersRepo');
const { createCollectorRepo } = require('../server/repos/collectorRepo');
const { createAuditRepo } = require('../server/repos/auditRepo');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

const nonce = `ret${Date.now().toString(36)}${process.pid}`;
let jobsHarness = null;
let raceHarness = null;
let tokensHarness = null;
let ingestHarness = null;
let ingestRaceHarness = null;
let auditHarness = null;
let auditRaceHarness = null;

// tables — какие production-таблицы (LIKE INCLUDING ALL) поднять в приватной схеме; buildDb —
// как собрать repo-методы над пулом этой схемы. LIKE копирует колонки/чеки/индексы, но НЕ FK,
// поэтому приватные таблицы — disposable-фикстуры без tenant-данных и без внешних ссылок.
async function createHarness(label, { tables = ['jobs', 'email_tokens'], buildDb } = {}) {
  const pg = require('pg');
  const schema = `${nonce}_${label}`;
  const admin = new pg.Pool({ connectionString: TEST_DB, max: 1, ssl: false });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of tables) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
    }
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({
    connectionString: TEST_DB,
    max: 2,
    ssl: false,
    options: `-c search_path=${schema},public`,
  });
  const defaultBuildDb = (p) => ({
    ...createJobsRepo({ pool: p, enabled: true }),
    ...createUsersRepo({ pool: p, enabled: true, transaction: async (fn) => fn(p) }),
  });
  const db = (buildDb || defaultBuildDb)(pool);
  return { schema, pool, db };
}

const buildCollectorDb = (p) =>
  createCollectorRepo({ pool: p, enabled: true, transaction: async (fn) => fn(p), setChannelTgId: async () => {} });
const buildAuditDb = (p) => createAuditRepo({ pool: p, enabled: true });

test.before(async () => {
  if (!TEST_DB) return;
  [jobsHarness, raceHarness, tokensHarness, ingestHarness, ingestRaceHarness, auditHarness, auditRaceHarness] =
    await Promise.all([
      createHarness('jobs'),
      createHarness('race'),
      createHarness('tokens'),
      createHarness('ingest', { tables: ['ingest_receipts', 'channel_daily', 'posts'], buildDb: buildCollectorDb }),
      createHarness('ingestrace', { tables: ['ingest_receipts'], buildDb: buildCollectorDb }),
      createHarness('audit', { tables: ['audit_events'], buildDb: buildAuditDb }),
      createHarness('auditrace', { tables: ['audit_events'], buildDb: buildAuditDb }),
    ]);
});

test.after(async () => {
  for (const h of [jobsHarness, raceHarness, tokensHarness, ingestHarness, ingestRaceHarness, auditHarness, auditRaceHarness]) {
    if (!h) continue;
    await h.pool.query(`DROP SCHEMA ${h.schema} CASCADE`);
    await h.pool.end();
  }
});

// Вставляет job-строку с явными status/updated_at (created_at = updated_at для простоты).
async function mkJob(h, tag, status, updatedDaysAgo, { lockedDaysAgo = null } = {}) {
  const key = `${h.schema}:${tag}`;
  await h.pool.query(
    `INSERT INTO jobs (kind, idempotency_key, status, attempts, locked_until, created_at, updated_at)
     VALUES ('ret_test', $1, $2, 1, $3, now() - make_interval(days => $4), now() - make_interval(days => $4))`,
    [key, status, lockedDaysAgo == null ? null : new Date(Date.now() - lockedDaysAgo * 86400000), updatedDaysAgo]);
  return key;
}
async function jobExists(h, key) {
  const { rows } = await h.pool.query(`SELECT 1 FROM jobs WHERE idempotency_key = $1`, [key]);
  return rows.length > 0;
}

// Вставляет email-token с явными created_at / used_at / expires_at.
async function mkToken(h, uid, tag, { createdDaysAgo, usedDaysAgo = null, expiresInDays }) {
  const { rows: [t] } = await h.pool.query(
    `INSERT INTO email_tokens (uid, kind, token_hash, expires_at, used_at, created_at)
     VALUES ($1, 'verify', $2,
             now() + make_interval(days => $3),
             $4, now() - make_interval(days => $5))
     RETURNING id`,
    [uid, `${nonce}:${tag}`,
     expiresInDays,
     usedDaysAgo == null ? null : new Date(Date.now() - usedDaysAgo * 86400000),
     createdDaysAgo]);
  return t.id;
}
async function tokenExists(h, id) {
  const { rows } = await h.pool.query(`SELECT 1 FROM email_tokens WHERE id = $1`, [id]);
  return rows.length > 0;
}

test('pruneTerminalJobs: границы времени, защита queued/running, повтор добирает cap-остаток', { skip }, async () => {
  const h = jobsHarness;
  // Горизонт = 10 дней. updated_at 11 дней → под удаление; 9 дней → выживает.
  const oldSucceeded = await mkJob(h, 'js-old-ok', 'succeeded', 11);
  const oldFailed = await mkJob(h, 'js-old-fail', 'failed', 11);
  const freshSucceeded = await mkJob(h, 'js-fresh-ok', 'succeeded', 9);   // моложе горизонта
  const oldQueued = await mkJob(h, 'js-old-queued', 'queued', 30);        // НИКОГДА не трогаем
  const oldRunningDeadLease = await mkJob(h, 'js-old-run', 'running', 30, { lockedDaysAgo: 20 }); // протухший lease — не наш

  const r = await h.db.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 500, maxBatches: 40 });
  assert.ok(r.deleted >= 2, 'удалены оба старых терминальных');

  assert.strictEqual(await jobExists(h, oldSucceeded), false, 'старый succeeded удалён');
  assert.strictEqual(await jobExists(h, oldFailed), false, 'старый failed удалён');
  assert.strictEqual(await jobExists(h, freshSucceeded), true, 'свежий терминальный выжил (граница)');
  assert.strictEqual(await jobExists(h, oldQueued), true, 'queued НИКОГДА не удаляется');
  assert.strictEqual(await jobExists(h, oldRunningDeadLease), true, 'running (даже с мёртвым lease) не удаляется');

  // Cap + повтор: 5 старых терминальных, batchSize=2, maxBatches=2 → 4 удалены, capped; остаток — следующей ночью.
  const keys = [];
  for (let i = 0; i < 5; i++) keys.push(await mkJob(h, `js-cap-${i}`, 'succeeded', 20));
  const capped = await h.db.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.deepStrictEqual(capped, { deleted: 4, batches: 2, capped: true },
    'ровно batchSize*maxBatches удалено и прогон помечен capped');
  const survivorsAfterCap = [];
  for (const k of keys) if (await jobExists(h, k)) survivorsAfterCap.push(k);
  assert.strictEqual(survivorsAfterCap.length, 1, 'один остаток пережил capped-прогон');

  const drain = await h.db.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(drain.capped, false, 'повторный прогон дочистил без cap');
  assert.strictEqual(await jobExists(h, survivorsAfterCap[0]), false, 'остаток добран следующим прогоном');

  // Идемпотентность: третий прогон на пустом хвосте — ноль удалений.
  const noop = await h.db.pruneTerminalJobs({ maxAgeDays: 10 });
  assert.strictEqual(noop.deleted, 0);
});

test('pruneTerminalJobs: занятый failed не блокирует cleanup и переживает concurrent reclaim', { skip }, async () => {
  const h = raceHarness;
  const key = await mkJob(h, 'js-reclaim-race', 'failed', 20);
  const locker = await h.pool.connect();
  const pg = require('pg');
  const prunePool = new pg.Pool({
    connectionString: TEST_DB,
    max: 1,
    ssl: false,
    options: `-c search_path=${h.schema},public`,
  });
  const raceRepo = createJobsRepo({ pool: prunePool, enabled: true });
  let inTransaction = false;
  try {
    await locker.query('BEGIN');
    inTransaction = true;
    const { rows: [row] } = await locker.query(
      'SELECT id FROM jobs WHERE idempotency_key=$1 FOR UPDATE', [key]);

    // A live claim already owns the row lock. Maintenance must SKIP it rather than wait behind the
    // user-facing/recovery path; the next daily pass can reconsider it.
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('retention waited on row lock')), 1000);
    });
    const result = await Promise.race([
      raceRepo.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 1, maxBatches: 1 }),
      timeout,
    ]).finally(() => clearTimeout(timeoutId));
    assert.strictEqual(result.deleted, 0, 'locked failed row was skipped');

    // The normal claim transition makes the protected row live before releasing the lock.
    await locker.query(
      `UPDATE jobs SET status='running', updated_at=now(), locked_until=now()+interval '15 minutes'
        WHERE id=$1`, [row.id]);
    await locker.query('COMMIT');
    inTransaction = false;

    const { rows: [after] } = await h.pool.query(
      'SELECT status FROM jobs WHERE idempotency_key=$1', [key]);
    assert.strictEqual(after.status, 'running');
  } finally {
    if (inTransaction) await locker.query('ROLLBACK').catch(() => {});
    locker.release();
    await prunePool.end();
  }
});

test('pruneEmailTokens: consumed/expired режутся, валидный неиспользованный выживает, границы', { skip }, async () => {
  const h = tokensHarness;
  const uid = 1; // private email_tokens table intentionally has no FK
  // Горизонт created_at = 10 дней.
  const consumedOld = await mkToken(h, uid, 'consumed-old', { createdDaysAgo: 11, usedDaysAgo: 5, expiresInDays: 30 });
  const expiredOld = await mkToken(h, uid, 'expired-old', { createdDaysAgo: 11, usedDaysAgo: null, expiresInDays: -1 }); // истёк, неиспользован
  const validUnusedOld = await mkToken(h, uid, 'valid-old', { createdDaysAgo: 11, usedDaysAgo: null, expiresInDays: 30 }); // ЖИВОЙ — защищён
  const consumedFresh = await mkToken(h, uid, 'consumed-fresh', { createdDaysAgo: 9, usedDaysAgo: 1, expiresInDays: 30 }); // моложе горизонта
  const validUnusedFresh = await mkToken(h, uid, 'valid-fresh', { createdDaysAgo: 1, usedDaysAgo: null, expiresInDays: 30 });

  const r = await h.db.pruneEmailTokens({ maxAgeDays: 10, batchSize: 500, maxBatches: 40 });
  assert.ok(r.deleted >= 2, 'удалены старые мёртвые токены');

  assert.strictEqual(await tokenExists(h, consumedOld), false, 'старый использованный удалён');
  assert.strictEqual(await tokenExists(h, expiredOld), false, 'старый истёкший (неиспользованный) удалён');
  assert.strictEqual(await tokenExists(h, validUnusedOld), true, 'валидный неиспользованный НЕ удаляется, даже если старый');
  assert.strictEqual(await tokenExists(h, consumedFresh), true, 'свежий использованный выжил (граница created_at)');
  assert.strictEqual(await tokenExists(h, validUnusedFresh), true, 'свежий валидный выжил');

  // Cap + повтор на пяти старых мёртвых токенах.
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await mkToken(h, uid, `tk-cap-${i}`, { createdDaysAgo: 20, usedDaysAgo: 10, expiresInDays: 30 }));
  const capped = await h.db.pruneEmailTokens({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.deepStrictEqual(capped, { deleted: 4, batches: 2, capped: true });
  let survivors = 0;
  for (const id of ids) if (await tokenExists(h, id)) survivors++;
  assert.strictEqual(survivors, 1, 'один остаток пережил capped-прогон');

  const drain = await h.db.pruneEmailTokens({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(drain.capped, false);
  let left = 0;
  for (const id of ids) if (await tokenExists(h, id)) left++;
  assert.strictEqual(left, 0, 'остаток добран повторным прогоном');
});

// ── ingest_receipts (90-дневная политика по received_at) ──────────────────────────────────────────
let ingestSeq = 0;
async function mkReceipt(h, channelId, receivedDaysAgo, { status = 'completed' } = {}) {
  const ingestId = `${h.schema}:ing-${ingestSeq++}`;
  await h.pool.query(
    `INSERT INTO ingest_receipts
       (channel_id, ingest_id, schema_version, collector_version, collected_at, received_at, payload_hash, status)
     VALUES ($1, $2, 1, 't', now() - make_interval(days => $3), now() - make_interval(days => $3), 'ph', $4)`,
    [channelId, ingestId, receivedDaysAgo, status]);
  return { channelId, ingestId };
}
async function receiptExists(h, r) {
  const { rows } = await h.pool.query(
    `SELECT 1 FROM ingest_receipts WHERE channel_id=$1 AND ingest_id=$2`, [r.channelId, r.ingestId]);
  return rows.length > 0;
}

test('pruneIngestReceipts: граница received_at, cap+drain, канонические channel_daily/posts нетронуты', { skip }, async () => {
  const h = ingestHarness;
  // Канонические tenant-строки (без age-TTL): очень старые, но ретеншн ingest их НЕ трогает.
  await h.pool.query(
    `INSERT INTO channel_daily (channel_id, day, subscribers, captured_at)
     VALUES (1, CURRENT_DATE - 700, 100, now() - make_interval(days => 700))`);
  await h.pool.query(
    `INSERT INTO posts (post_id, date_published, views, updated_at)
     VALUES (12345, now() - make_interval(days => 700), 50, now() - make_interval(days => 700))`);

  // Горизонт = 90 дней. received_at 91 дн → под удаление; 89 дн → выживает.
  const old1 = await mkReceipt(h, 1, 91);
  const old2 = await mkReceipt(h, 2, 120);
  const fresh = await mkReceipt(h, 1, 89);
  // Разный статус не важен: политика чисто возрастная (в отличие от jobs с status-предикатом).
  const oldFailed = await mkReceipt(h, 3, 200, { status: 'failed' });

  const r = await h.db.pruneIngestReceipts({ maxAgeDays: 90, batchSize: 500, maxBatches: 40 });
  assert.ok(r.deleted >= 3, 'удалены все квитанции старше 90 дней');

  assert.strictEqual(await receiptExists(h, old1), false, 'старая квитанция удалена');
  assert.strictEqual(await receiptExists(h, old2), false, 'старая квитанция другого канала удалена');
  assert.strictEqual(await receiptExists(h, oldFailed), false, 'статус не защищает — режем по возрасту');
  assert.strictEqual(await receiptExists(h, fresh), true, 'свежая квитанция выжила (граница received_at)');

  // Канонические аналитические строки НЕ имеют age-TTL и остаются нетронутыми.
  const cd = await h.pool.query(`SELECT count(*)::int AS n FROM channel_daily`);
  const ps = await h.pool.query(`SELECT count(*)::int AS n FROM posts`);
  assert.strictEqual(cd.rows[0].n, 1, 'channel_daily (канон) не тронут ретеншном квитанций');
  assert.strictEqual(ps.rows[0].n, 1, 'posts (канон) не тронут ретеншном квитанций');

  // Cap + повтор: 5 старых квитанций, batchSize=2, maxBatches=2 → 4 удалены, capped; остаток — потом.
  const capKeys = [];
  for (let i = 0; i < 5; i++) capKeys.push(await mkReceipt(h, 10 + i, 150));
  const capped = await h.db.pruneIngestReceipts({ maxAgeDays: 90, batchSize: 2, maxBatches: 2 });
  assert.deepStrictEqual(capped, { deleted: 4, batches: 2, capped: true });
  let survivors = 0;
  for (const k of capKeys) if (await receiptExists(h, k)) survivors++;
  assert.strictEqual(survivors, 1, 'один остаток пережил capped-прогон');

  const drain = await h.db.pruneIngestReceipts({ maxAgeDays: 90, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(drain.capped, false, 'повторный прогон дочистил без cap');
  survivors = 0;
  for (const k of capKeys) if (await receiptExists(h, k)) survivors++;
  assert.strictEqual(survivors, 0, 'остаток добран следующим прогоном');
});

test('pruneIngestReceipts: активная ingest-транзакция (FOR UPDATE) пропускается, не блокирует cleanup', { skip }, async () => {
  const h = ingestRaceHarness;
  const locked = await mkReceipt(h, 1, 200);
  const other = await mkReceipt(h, 2, 200);
  const locker = await h.pool.connect();
  const pg = require('pg');
  const prunePool = new pg.Pool({
    connectionString: TEST_DB, max: 1, ssl: false, options: `-c search_path=${h.schema},public`,
  });
  const raceRepo = createCollectorRepo({ pool: prunePool, enabled: true, transaction: async (fn) => fn(prunePool), setChannelTgId: async () => {} });
  let inTransaction = false;
  try {
    await locker.query('BEGIN');
    inTransaction = true;
    // Модель активного приёма: ingest держит FOR UPDATE на своей квитанции.
    await locker.query(
      'SELECT 1 FROM ingest_receipts WHERE channel_id=$1 AND ingest_id=$2 FOR UPDATE', [locked.channelId, locked.ingestId]);

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('retention waited on active ingest lock')), 1000);
    });
    // batchSize=1: если бы SKIP LOCKED не работал, запрос завис бы на залоченной строке до таймаута.
    const result = await Promise.race([
      raceRepo.pruneIngestReceipts({ maxAgeDays: 90, batchSize: 1, maxBatches: 5 }),
      timeout,
    ]).finally(() => clearTimeout(timeoutId));
    assert.ok(result.deleted >= 1, 'незалоченная старая квитанция удалена, залоченная пропущена');
    await locker.query('COMMIT');
    inTransaction = false;

    assert.strictEqual(await receiptExists(h, locked), true, 'залоченная квитанция пережила прогон (доберёт следующий)');
    assert.strictEqual(await receiptExists(h, other), false, 'незалоченная старая квитанция удалена');
  } finally {
    if (inTransaction) await locker.query('ROLLBACK').catch(() => {});
    locker.release();
    await prunePool.end();
  }
});

// ── audit_events (365-дневная политика по created_at) ─────────────────────────────────────────────
async function mkAudit(h, action, createdDaysAgo) {
  const { rows: [row] } = await h.pool.query(
    `INSERT INTO audit_events (action, created_at)
     VALUES ($1, now() - make_interval(days => $2)) RETURNING id`,
    [action, createdDaysAgo]);
  return row.id;
}
async function auditExists(h, id) {
  const { rows } = await h.pool.query(`SELECT 1 FROM audit_events WHERE id=$1`, [id]);
  return rows.length > 0;
}

test('pruneAuditEvents: граница created_at, cap+drain', { skip }, async () => {
  const h = auditHarness;
  // Горизонт = 365 дней. created_at 366 дн → под удаление; 364 дн → выживает.
  const old1 = await mkAudit(h, 'a.old1', 366);
  const old2 = await mkAudit(h, 'a.old2', 500);
  const fresh = await mkAudit(h, 'a.fresh', 364);

  const r = await h.db.pruneAuditEvents({ maxAgeDays: 365, batchSize: 500, maxBatches: 40 });
  assert.ok(r.deleted >= 2, 'удалены события старше года');
  assert.strictEqual(await auditExists(h, old1), false, 'старое событие удалено');
  assert.strictEqual(await auditExists(h, old2), false, 'очень старое событие удалено');
  assert.strictEqual(await auditExists(h, fresh), true, 'свежее событие выжило (граница created_at)');

  const capIds = [];
  for (let i = 0; i < 5; i++) capIds.push(await mkAudit(h, `a.cap${i}`, 400));
  const capped = await h.db.pruneAuditEvents({ maxAgeDays: 365, batchSize: 2, maxBatches: 2 });
  assert.deepStrictEqual(capped, { deleted: 4, batches: 2, capped: true });
  let survivors = 0;
  for (const id of capIds) if (await auditExists(h, id)) survivors++;
  assert.strictEqual(survivors, 1, 'один остаток пережил capped-прогон');

  const drain = await h.db.pruneAuditEvents({ maxAgeDays: 365, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(drain.capped, false);
  survivors = 0;
  for (const id of capIds) if (await auditExists(h, id)) survivors++;
  assert.strictEqual(survivors, 0, 'остаток добран повторным прогоном');
});

test('pruneAuditEvents: залоченная строка пропускается (SKIP LOCKED), cleanup не ждёт', { skip }, async () => {
  const h = auditRaceHarness;
  const locked = await mkAudit(h, 'a.locked', 500);
  const other = await mkAudit(h, 'a.other', 500);
  const locker = await h.pool.connect();
  const pg = require('pg');
  const prunePool = new pg.Pool({
    connectionString: TEST_DB, max: 1, ssl: false, options: `-c search_path=${h.schema},public`,
  });
  const raceRepo = createAuditRepo({ pool: prunePool, enabled: true });
  let inTransaction = false;
  try {
    await locker.query('BEGIN');
    inTransaction = true;
    await locker.query('SELECT 1 FROM audit_events WHERE id=$1 FOR UPDATE', [locked]);

    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('audit retention waited on row lock')), 1000);
    });
    const result = await Promise.race([
      raceRepo.pruneAuditEvents({ maxAgeDays: 365, batchSize: 1, maxBatches: 5 }),
      timeout,
    ]).finally(() => clearTimeout(timeoutId));
    assert.ok(result.deleted >= 1, 'незалоченное старое событие удалено, залоченное пропущено');
    await locker.query('COMMIT');
    inTransaction = false;

    assert.strictEqual(await auditExists(h, locked), true, 'залоченное событие пережило прогон');
    assert.strictEqual(await auditExists(h, other), false, 'незалоченное старое событие удалено');
  } finally {
    if (inTransaction) await locker.query('ROLLBACK').catch(() => {});
    locker.release();
    await prunePool.end();
  }
});
