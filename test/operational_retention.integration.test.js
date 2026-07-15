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

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

const nonce = `ret${Date.now().toString(36)}${process.pid}`;
let jobsHarness = null;
let raceHarness = null;
let tokensHarness = null;

async function createHarness(label) {
  const pg = require('pg');
  const schema = `${nonce}_${label}`;
  const admin = new pg.Pool({ connectionString: TEST_DB, max: 1, ssl: false });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    // LIKE INCLUDING ALL preserves the production column/check/index shape without copying FKs;
    // the private tables are disposable test fixtures, never tenant/product data.
    await admin.query(`CREATE TABLE ${schema}.jobs (LIKE public.jobs INCLUDING ALL)`);
    await admin.query(`CREATE TABLE ${schema}.email_tokens (LIKE public.email_tokens INCLUDING ALL)`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({
    connectionString: TEST_DB,
    max: 2,
    ssl: false,
    options: `-c search_path=${schema},public`,
  });
  const db = {
    ...createJobsRepo({ pool, enabled: true }),
    ...createUsersRepo({ pool, enabled: true, transaction: async (fn) => fn(pool) }),
  };
  return { schema, pool, db };
}

test.before(async () => {
  if (!TEST_DB) return;
  [jobsHarness, raceHarness, tokensHarness] = await Promise.all([
    createHarness('jobs'),
    createHarness('race'),
    createHarness('tokens'),
  ]);
});

test.after(async () => {
  for (const h of [jobsHarness, raceHarness, tokensHarness]) {
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
